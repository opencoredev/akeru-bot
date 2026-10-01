
import type { ObservationalMemoryRecord } from "@mastra/core/storage";
import { type AkeruConversationMemorySnapshot } from "@akeru/contracts";
import * as DateTime from "effect/DateTime";

import { type AkeruMastraHarness } from "./AkeruHarnessTypes.ts";
import { createAkeruMastraMemory } from "./AkeruMemory.ts";
import { AkeruObservationRestoreError } from "./AkeruHarnessErrors.ts";

export function createAkeruConversation(
  observationalMemory: Awaited<ReturnType<typeof createAkeruMastraMemory>>,
  registerResource: (threadId: string, resourceId?: string) => void,
  queueObservation: <Result>(
    threadId: string,
    resourceId: string,
    work: () => Promise<Result>,
  ) => Promise<Result>,
  discardQueuedObservations: { readonly run: (threadId: string, resourceId: string) => void },
) {
  const persistExternalTurn = async (
    input: Parameters<NonNullable<AkeruMastraHarness["observeExternalTurn"]>>[0],
  ) => {
    const existingThread = await observationalMemory.memory.getThreadById({
      threadId: input.threadId,
      resourceId: input.threadId,
    });

    if (!existingThread) {
      await observationalMemory.memory.createThread({
        threadId: input.threadId,
        resourceId: input.threadId,
      });
    }

    const createdAt = DateTime.toDate(DateTime.makeUnsafe(input.createdAt));
    await observationalMemory.memory.persistMessages([
      ...input.userMessages.map((message) => ({
        id: `${input.turnId}:user:${message.id}`,
        role: "user" as const,
        content: { format: 2 as const, parts: [{ type: "text" as const, text: message.text }] },
        createdAt,
        threadId: input.threadId,
        resourceId: input.threadId,
      })),
      {
        id: `${input.turnId}:assistant`,
        role: "assistant",
        content: { format: 2, parts: [{ type: "text", text: input.assistant }] },
        createdAt,
        threadId: input.threadId,
        resourceId: input.threadId,
      },
    ]);
  };

  const readObservationalMemory = async (threadId: string, resourceId?: string) => {
    registerResource(threadId, resourceId ?? threadId);

    const normalize = (
      record: Awaited<ReturnType<typeof observationalMemory.engine.getRecord>>,
    ) => {
      if (!record) return null;

      return {
        id: record.id,
        generationCount: record.generationCount,
        originType: record.originType,
        activeObservations: record.activeObservations,
        bufferedObservations: [
          ...(record.bufferedObservationChunks?.map((chunk) => chunk.observations) ?? []),
          ...(record.bufferedObservations ? [record.bufferedObservations] : []),
        ].join("\n\n"),
        bufferedReflection: record.bufferedReflection ?? null,
        totalTokensObserved: record.totalTokensObserved,
        observationTokenCount: record.observationTokenCount,
        createdAt: record.createdAt.toISOString(),
        updatedAt: record.updatedAt.toISOString(),
      };
    };

    const [current, history] = await Promise.all([
      observationalMemory.engine.getRecord(threadId, resourceId),
      observationalMemory.engine.getHistory(threadId, resourceId, 50),
    ]);

    return { current: normalize(current), history: history.map((record) => normalize(record)!) };
  };

  const restoreRecords = async (
    threadId: string,
    snapshot: AkeruConversationMemorySnapshot,
    resourceId: string,
    expectedSnapshot: AkeruConversationMemorySnapshot | undefined,
  ) => {
    const store = observationalMemory.engine.getStorage();

    if (
      expectedSnapshot &&
      JSON.stringify(await readObservationalMemory(threadId, resourceId)) !==
        JSON.stringify(expectedSnapshot)
    ) {
      throw new Error("Observations changed after the import preview. Preview the archive again.");
    }

    discardQueuedObservations.run(threadId, resourceId);

    const originals = await store.getObservationalMemoryHistory(
      threadId,
      resourceId,
      Number.MAX_SAFE_INTEGER,
    );

    const replace = async () => {
      await store.clearObservationalMemory(threadId, resourceId);
      const records = [...snapshot.history, ...(snapshot.current ? [snapshot.current] : [])];
      const seen = new Set<string>();

      for (const record of records) {
        if (seen.has(record.id)) continue;
        seen.add(record.id);
        await store.insertObservationalMemoryRecord({
          id: record.id,
          scope: "thread",
          threadId,
          resourceId,
          createdAt: DateTime.toDate(DateTime.makeUnsafe(record.createdAt)),
          updatedAt: DateTime.toDate(DateTime.makeUnsafe(record.updatedAt)),
          lastObservedAt: DateTime.toDate(DateTime.makeUnsafe(record.updatedAt)),
          originType: record.originType,
          generationCount: record.generationCount,
          // Archives flatten buffered chunks, so restore their text as active observations.
          activeObservations: [record.activeObservations, record.bufferedObservations]
            .filter(Boolean)
            .join("\n\n"),
          ...(record.bufferedReflection ? { bufferedReflection: record.bufferedReflection } : {}),
          totalTokensObserved: record.totalTokensObserved,
          observationTokenCount:
            record.observationTokenCount + Math.ceil(record.bufferedObservations.length / 4),
          pendingMessageTokens: 0,
          isReflecting: false,
          isObserving: false,
          isBufferingObservation: false,
          isBufferingReflection: false,
          lastBufferedAtTokens: 0,
          lastBufferedAtTime: null,
          config: {},
        } satisfies ObservationalMemoryRecord);
      }
    };

    const rollback = async () => {
      await store.clearObservationalMemory(threadId, resourceId);

      for (const original of originals) await store.insertObservationalMemoryRecord(original);
    };

    try {
      await replace();
    } catch (cause) {
      // The original failure stays the error's cause whether or not the
      // rollback lands; a rollback failure is carried beside it.
      let rollbackFailure: { readonly cause: unknown } | undefined;
      await rollback().catch((cause: unknown) => {
        rollbackFailure = { cause };
      });
      throw new AkeruObservationRestoreError({
        threadId,
        resourceId,
        rolledBack: rollbackFailure === undefined,
        cause,
        ...(rollbackFailure ? { rollbackCause: rollbackFailure.cause } : {}),
      });
    }
  };

  // Clear and restore discard pending observations for the chat, so a retry
  // cannot write observations back over the user's change.
  const clearObservationalMemory = (threadId: string, resourceId = threadId) =>
    queueObservation(threadId, resourceId, () => {
      discardQueuedObservations.run(threadId, resourceId);

      return observationalMemory.engine.clear(threadId, resourceId);
    });

  return { readObservationalMemory, restoreRecords, clearObservationalMemory, persistExternalTurn };
}
