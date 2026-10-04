import { ProviderDriverKind } from "@akeru/contracts";
import type { AkeruToolRuntime } from "../../AkeruToolRuntime.ts";

import * as FileSystem from "effect/FileSystem";

import type { MastraDBMessage } from "@mastra/core/agent-controller";

import { TurnId, type BotId, type ProviderRuntimeEvent, ThreadId } from "@akeru/contracts";

import * as DateTime from "effect/DateTime";

import * as Effect from "effect/Effect";

import * as Option from "effect/Option";

import { resolveAttachmentPath } from "../../../attachmentStore.ts";

import { ServerConfig } from "../../../config.ts";

import { retainProjectionMessagesAfterRevert } from "../../../orchestration/RetainedRevertMessages.ts";
import { ProjectionThreadMessageRepository } from "../../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionTurnRepository } from "../../../persistence/Services/ProjectionTurns.ts";

import type { AkeruControllerHarness } from "../../mastra/AkeruHarnessTypes.ts";

import type { AkeruWorkerRuntime } from "../../AkeruWorkerRuntime.ts";

import { cancelActiveImageGenerations } from "../../../image-generation/ImageGenerationRuntime.ts";

import { AkeruSessionResources } from "../../AkeruSessionResources.ts";

import { AgentControllerRuntimeError } from "../../Errors.ts";
import { type AgentControllerShape } from "../../Services/AgentController.ts";
import { LegacyProviderBridge } from "../../Services/LegacyProviderBridge.ts";

import {
  type ResolvedEngine,
  type ActiveSession,
  type LegacyTurnMemoryState,
  type LegacyResourceIdentity,
} from "./State.ts";

export function createConversation(deps: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sessions: Map<string, ActiveSession>;
  readonly legacyProviderBridge: LegacyProviderBridge["Service"];
  readonly legacyPending: (key: string) => LegacyTurnMemoryState[];
  readonly restoreLegacyMemoryHandler: (key: string, pending: LegacyTurnMemoryState) => void;
  readonly legacyTurnMemory: Map<string, LegacyTurnMemoryState[]>;
  readonly legacyBufferedTerminals: Map<string, Map<string, ProviderRuntimeEvent>>;
  readonly runMastra: <A>(
    operation: string,
    run: (signal: AbortSignal) => Promise<A>,
  ) => Effect.Effect<A, AgentControllerRuntimeError, never>;
  readonly sessionResources: AkeruSessionResources;
  readonly clearPreviewMcpSession: (threadId: ThreadId) => Effect.Effect<void, never, never>;
  readonly legacyResourceIdentity: Map<string, LegacyResourceIdentity>;
  readonly usesMastraCode: (provider: ProviderDriverKind) => boolean;
  readonly resolvedByThread: Map<string, ResolvedEngine>;
  readonly toolRuntime: AkeruToolRuntime;
  readonly endTurnAdmissionGeneration: (active: ActiveSession) => void;
  readonly releaseMastraReservations: (threadId: ThreadId) => Effect.Effect<void, never, never>;
  readonly finishTurn: (
    threadId: ThreadId,
    active: ActiveSession,
    state: "completed" | "failed" | "interrupted",
    errorMessage?: string,
  ) => void;
  readonly cancelAllPendingApprovals: (threadId: ThreadId, active: ActiveSession) => void;
  readonly publishSessionState: (
    threadId: ThreadId,
    active: ActiveSession,
    state: "ready" | "running" | "waiting" | "stopped" | "error",
    reason?: string,
  ) => void;
  readonly bundle: AkeruControllerHarness;
  readonly memoryUsageByThread: Map<string, { readonly botId: BotId; turnId: TurnId }>;
  readonly workerRuntime: AkeruWorkerRuntime;
  readonly workerTurnDefaults: Map<
    string,
    "approval-required" | "auto-accept-edits" | "auto" | "full-access"
  >;
  readonly projectionMessages: Option.Option<ProjectionThreadMessageRepository["Service"]>;
  readonly projectionTurns: Option.Option<ProjectionTurnRepository["Service"]>;
  readonly config: ServerConfig["Service"];
  readonly interruptTurn: AgentControllerShape["interruptTurn"];
  readonly startSession: AgentControllerShape["startSession"];
}) {
  const stopSessionWithResources = Effect.fn("AgentController.stopSession")(function* (
    input: Parameters<AgentControllerShape["stopSession"]>[0],
    destroyResources: boolean,
  ) {
    // A stopped chat must not receive an image that finishes later.
    yield* cancelActiveImageGenerations(input.threadId);
    const key = String(input.threadId);
    const active = deps.sessions.get(key);

    if (!active) {
      const legacySessions = yield* deps.legacyProviderBridge.listSessions();

      if (legacySessions.some((session) => session.threadId === input.threadId)) {
        const pendingTurns = deps.legacyPending(key);

        for (const pending of pendingTurns) deps.restoreLegacyMemoryHandler(key, pending);
        deps.legacyTurnMemory.delete(key);
        deps.legacyBufferedTerminals.delete(key);
        yield* Effect.forEach(
          pendingTurns,
          (pendingMemory) =>
            pendingMemory.memoryTurn
              ? deps
                  .runMastra("memory.abandon", () => pendingMemory.memoryTurn!.abandon())
                  .pipe(Effect.ignoreCause({ log: true }))
              : Effect.void,
          { discard: true },
        );
        yield* deps.legacyProviderBridge.stopSession(input).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* deps
                .runMastra("resources.release", () =>
                  deps.sessionResources.release(key, { destroy: destroyResources }),
                )
                .pipe(Effect.ignoreCause({ log: true }));
              yield* deps.clearPreviewMcpSession(input.threadId);
              deps.legacyResourceIdentity.delete(key);
            }),
          ),
        );

        return;
      }

      if (
        deps.usesMastraCode(
          deps.resolvedByThread.get(key)?.provider ?? ProviderDriverKind.make("codex"),
        )
      ) {
        yield* deps
          .runMastra("resources.release", () =>
            deps.sessionResources.release(key, { destroy: destroyResources }),
          )
          .pipe(Effect.ignoreCause({ log: true }));
        yield* deps.clearPreviewMcpSession(input.threadId);
        deps.toolRuntime.unregisterSession(key);

        return;
      }

      return yield* deps.legacyProviderBridge.stopSession(input);
    }

    deps.endTurnAdmissionGeneration(active);
    active.pendingTurns.length = 0;
    active.admittingTurn = null;
    active.session.abort();
    yield* deps.releaseMastraReservations(input.threadId);

    if (active.activeTurn) {
      deps.finishTurn(input.threadId, active, "interrupted");
    } else {
      deps.cancelAllPendingApprovals(input.threadId, active);
    }

    active.unsubscribe();
    deps.publishSessionState(input.threadId, active, "stopped");
    yield* deps
      .runMastra("deleteSession", () => deps.bundle.controller.deleteSession({ resourceId: key }))
      .pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* deps
              .runMastra("resources.release", () =>
                deps.sessionResources.release(key, { destroy: destroyResources }),
              )
              .pipe(Effect.ignoreCause({ log: true }));
            yield* deps.clearPreviewMcpSession(input.threadId);
            deps.toolRuntime.unregisterSession(key);
            deps.sessions.delete(key);
            deps.memoryUsageByThread.delete(key);
            yield* deps.workerRuntime.releaseThread(input.threadId);
            deps.workerTurnDefaults.delete(key);
          }),
        ),
      );
  });

  const stopSession: AgentControllerShape["stopSession"] = (input) =>
    stopSessionWithResources(input, false);

  const rollbackConversation: AgentControllerShape["rollbackConversation"] = Effect.fn(
    "AgentController.rollbackConversation",
  )(function* (input) {
    if (input.numTurns === 0) return;
    const resolved = deps.resolvedByThread.get(String(input.threadId));

    if (!deps.sessions.has(String(input.threadId)) && !resolved) {
      return yield* deps.legacyProviderBridge.rollbackConversation(input);
    }

    if (resolved && !deps.usesMastraCode(resolved.provider)) {
      return yield* deps.legacyProviderBridge.rollbackConversation(input);
    }

    const active = deps.sessions.get(String(input.threadId));

    if (
      !active ||
      !deps.bundle.rebuildConversation ||
      Option.isNone(deps.projectionMessages) ||
      Option.isNone(deps.projectionTurns)
    ) {
      return yield* new AgentControllerRuntimeError({
        operation: "rollbackConversation",
        detail: "Conversation history is unavailable for rebuilding the provider session.",
      });
    }

    const turns = yield* deps.projectionTurns.value.listByThreadId({ threadId: input.threadId });

    const messages = yield* deps.projectionMessages.value.listByThreadId({
      threadId: input.threadId,
    });

    const currentTurnCount = turns.reduce(
      (count, turn) => Math.max(count, turn.checkpointTurnCount ?? 0),
      0,
    );

    const retained = retainProjectionMessagesAfterRevert(
      messages,
      turns,
      Math.max(0, currentTurnCount - input.numTurns),
    );

    const key = String(input.threadId);

    const attachmentReadError = (cause: unknown) =>
      new AgentControllerRuntimeError({
        operation: "rollbackConversation",
        detail: "Could not rebuild retained conversation attachments.",
        cause,
      });

    const transcript: MastraDBMessage[] = yield* Effect.forEach(retained, (message) =>
      Effect.gen(function* () {
        const attachments = yield* Effect.forEach(message.attachments ?? [], (attachment) => {
          const path = resolveAttachmentPath({
            attachmentsDir: deps.config.attachmentsDir,
            attachment,
          });

          if (path === null)
            return Effect.fail(
              attachmentReadError(new Error(`Invalid attachment '${attachment.id}'.`)),
            );

          return deps.fileSystem.readFile(path).pipe(
            Effect.map((bytes) => ({
              name: attachment.name,
              contentType: attachment.mimeType,
              url: `data:${attachment.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
            })),
            Effect.mapError(attachmentReadError),
          );
        });

        return yield* Effect.try({
          try: () => ({
            id: String(message.messageId),
            role: message.role,
            content: {
              format: 2 as const,
              parts: [
                {
                  type: "text" as const,
                  text: [
                    message.text,
                    ...(message.attachments ?? []).map((attachment) => {
                      const path = resolveAttachmentPath({
                        attachmentsDir: deps.config.attachmentsDir,
                        attachment,
                      });

                      return `[Attached ${attachment.type} "${attachment.name}" is saved at: ${path}]`;
                    }),
                  ]
                    .filter(Boolean)
                    .join("\n\n"),
                },
              ],
              ...(attachments.length ? { experimental_attachments: attachments } : {}),
            },
            createdAt: DateTime.toDate(DateTime.makeUnsafe(message.createdAt)),
            threadId: key,
            resourceId: key,
          }),
          catch: attachmentReadError,
        });
      }),
    );

    const startInput = {
      ...active.startInput,
      runtimeMode: active.runtimeMode,
      ...(resolved ? { modelSelection: resolved.modelSelection } : {}),
    };

    const drainLifetime = new AbortController();

    const drained = (async () => {
      while (
        !drainLifetime.signal.aborted &&
        (active.session.stream.isActive() || active.session.run.getRunId() !== null)
      ) {
        const wake = new AbortController();
        const cancel = () => wake.abort();
        drainLifetime.signal.addEventListener("abort", cancel, { once: true });

        try {
          await Promise.race([
            active.session.stream.waitForTeardown(wake.signal),
            active.session.run.waitForTeardown(wake.signal),
          ]);
        } finally {
          drainLifetime.signal.removeEventListener("abort", cancel);
          wake.abort();
        }
      }
    })();

    yield* deps.interruptTurn({ threadId: input.threadId });
    yield* deps
      .runMastra("drainConversation", async () => {
        await Promise.allSettled(active.pendingDispatches);
        await drained;
      })
      .pipe(Effect.ensuring(Effect.sync(() => drainLifetime.abort())));
    yield* stopSession({ threadId: input.threadId });

    const restore = yield* deps.runMastra("rebuildConversation", () =>
      deps.bundle.rebuildConversation!(key, transcript),
    );

    // A failed restart restores the original transcript and reopens its session, so the chat
    // keeps a live provider session even though the revert fails.
    yield* deps
      .startSession(input.threadId, startInput)
      .pipe(
        Effect.catch((error) =>
          deps
            .runMastra("restoreConversation", restore)
            .pipe(
              Effect.andThen(
                deps
                  .startSession(input.threadId, startInput)
                  .pipe(Effect.ignoreCause({ log: true })),
              ),
              Effect.andThen(Effect.fail(error)),
            ),
        ),
      );
  });

  return { stopSessionWithResources, stopSession, rollbackConversation };
}
