// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { ProviderDriverKind } from "@akeru/contracts";
import { CommandId, EventId, MessageId, ThreadId } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import {
  asTurnId,
  waitForGitRefExists,
  waitForEvent,
  waitForThread,
  gitRefExists,
  gitShowFileAtRef,
  createCheckpointHarness,
} from "./test-support/CheckpointHarness.ts";

describe("CheckpointReactor", () => {
  const testScope = createCheckpointHarness();
  const { createHarness } = testScope;
  afterEach(testScope.dispose);
  it("captures pre-turn baseline on turn.started and post-turn checkpoint on turn.completed", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await harness.run(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-capture"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-1"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
    });
    await waitForGitRefExists(
      harness,
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );

    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-1"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness, (event) => event.type === "thread.turn-diff-completed");

    const thread = await waitForThread(
      harness,
      (entry) => entry.latestTurn?.turnId === "turn-1" && entry.checkpoints.length === 1,
    );

    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0)),
    ).toBe(true);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(true);
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
        "README.md",
      ),
    ).toBe("v1\n");
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        "README.md",
      ),
    ).toBe("v2\n");
  });

  it("links a completion checkpoint to the newest assistant message of its turn", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.make("thread-1");
    const createdAt = "2026-01-01T00:00:00.000Z";

    const assistantMessages = [
      { id: "assistant-turn-1-first", turnId: "turn-1", at: "2026-01-01T00:00:01.000Z" },
      { id: "assistant-turn-1-latest", turnId: "turn-1", at: "2026-01-01T00:00:02.000Z" },
      { id: "assistant-other-turn", turnId: "turn-other", at: "2026-01-01T00:00:03.000Z" },
    ] as const;

    await harness.run(
      Effect.gen(function* () {
        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set-assistant-link"),
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        });
        harness.provider.emit({
          type: "turn.started",
          eventId: EventId.make("evt-turn-started-assistant-link"),
          provider: ProviderDriverKind.make("codex"),
          createdAt,
          threadId,
          turnId: asTurnId("turn-1"),
        });
        yield* Effect.promise(() =>
          waitForGitRefExists(harness, harness.cwd, checkpointRefForThreadTurn(threadId, 0)),
        );

        for (const message of assistantMessages) {
          yield* harness.engine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: CommandId.make(`cmd-delta-${message.id}`),
            threadId,
            messageId: MessageId.make(message.id),
            delta: message.id,
            turnId: asTurnId(message.turnId),
            createdAt: message.at,
          });
          yield* harness.engine.dispatch({
            type: "thread.message.assistant.complete",
            commandId: CommandId.make(`cmd-complete-${message.id}`),
            threadId,
            messageId: MessageId.make(message.id),
            turnId: asTurnId(message.turnId),
            createdAt: message.at,
          });
        }
      }),
    );

    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-assistant-link"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:04.000Z",
      threadId,
      turnId: asTurnId("turn-1"),
      payload: { state: "completed" },
    });

    const events = await waitForEvent(
      harness,
      (event) => event.type === "thread.turn-diff-completed",
    );

    const diffCompleted = events.find((event) => event.type === "thread.turn-diff-completed");
    expect(
      diffCompleted?.type === "thread.turn-diff-completed"
        ? diffCompleted.payload.assistantMessageId
        : undefined,
    ).toBe("assistant-turn-1-latest");
  });

  it("does not capture a checkpoint for imported conversation history", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });

    const createdAt = "2026-01-01T00:00:00.000Z";

    await testScope.runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.history.restore",
        commandId: CommandId.make("cmd-import-history"),
        threadId: ThreadId.make("thread-1"),
        messages: [
          {
            id: MessageId.make("message-imported"),
            role: "user",
            text: "Imported history",
            turnId: null,
            streaming: false,
            createdAt,
            updatedAt: createdAt,
          },
        ],
        proposedPlans: [],
        activities: [],
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        archivedAt: null,
        updatedAt: createdAt,
      }),
    );
    await harness.drain();

    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0)),
    ).toBe(false);
  });
});
