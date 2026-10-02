import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { ProviderDriverKind } from "@akeru/contracts";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ThreadId,
} from "@akeru/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import {
  asTurnId,
  gitShowFileAtRef,
  waitForEvent,
  waitForGitRefExists,
  gitRefExists,
  createCheckpointHarness,
} from "./test-support/CheckpointHarness.ts";

describe("CheckpointReactor", () => {
  const testScope = createCheckpointHarness();
  const { createHarness } = testScope;
  afterEach(testScope.dispose);
  it("refreshes local git status state on turn completion using the session cwd", async () => {
    const gitStatusRefreshCalls: string[] = [];

    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      gitStatusRefreshCalls,
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-refresh-local-status"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-refresh-local-status"),
      payload: { state: "completed" },
    });

    await harness.drain();

    expect(gitStatusRefreshCalls).toEqual([harness.cwd]);
  });

  effectIt.effect("captures files while git status refresh is still pending", () =>
    Effect.gen(function* () {
      const lookupStarted = yield* Deferred.make<void>();
      const finishLookup = yield* Deferred.make<void>();

      const harness = yield* Effect.promise(() =>
        createHarness({
          seedFilesystemCheckpoints: false,
          gitStatusRefresh: Deferred.succeed(lookupStarted, undefined).pipe(
            Effect.andThen(Deferred.await(finishLookup)),
          ),
        }),
      );

      NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "completed turn\n");
      harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.make("evt-turn-completed-slow-status"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-slow-status"),
        payload: { state: "completed" },
      });

      yield* Deferred.await(lookupStarted);
      yield* Effect.gen(function* () {
        expect(yield* harness.nextReceipt).toMatchObject({
          type: "checkpoint.diff.finalized",
          turnId: "turn-slow-status",
        });
        expect(
          gitShowFileAtRef(
            harness.cwd,
            checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
            "README.md",
          ),
        ).toBe("completed turn\n");
      }).pipe(Effect.ensuring(Deferred.succeed(finishLookup, undefined)));
      yield* Effect.promise(harness.drain);
    }),
  );

  it("adopts a drifted checkout as the thread branch on a dedicated worktree", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "t3code/original-branch",
      localStatusRefName: "t3code/renamed-by-agent",
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-branch-drift"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-branch-drift"),
      payload: { state: "completed" },
    });

    await harness.drain();
    await waitForEvent(
      harness,
      (event) =>
        event.type === "thread.meta-updated" && event.payload.branch === "t3code/renamed-by-agent",
    );

    const snapshot = await harness.readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.branch).toBe("t3code/renamed-by-agent");
  });

  it("does not adopt a drifted checkout when the worktree is shared by another thread", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "t3code/original-branch",
      localStatusRefName: "t3code/renamed-by-agent",
      secondThreadSharingWorktree: true,
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-branch-drift-shared"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-branch-drift-shared"),
      payload: { state: "completed" },
    });

    await harness.drain();

    const snapshot = await harness.readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.branch).toBe("t3code/original-branch");
  });

  it("does not adopt a temporary placeholder checkout as the thread branch", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "t3code/original-branch",
      localStatusRefName: "t3code/0a1b2c3d",
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-branch-drift-temp"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-branch-drift-temp"),
      payload: { state: "completed" },
    });

    await harness.drain();

    const snapshot = await harness.readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.branch).toBe("t3code/original-branch");
  });

  it("captures pre-turn baseline from project workspace root when thread worktree is unset", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });

    await harness.run(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-for-baseline"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: MessageId.make("message-user-1"),
          role: "user",
          text: "start turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await waitForGitRefExists(
      harness,
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
        "README.md",
      ),
    ).toBe("v1\n");
  });

  it("captures turn completion checkpoint from project workspace root when provider session cwd is unavailable", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });

    const createdAt = "2026-01-01T00:00:00.000Z";

    await harness.run(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-missing-provider-cwd"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-missing-cwd"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-missing-provider-cwd"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-missing-cwd"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness, (event) => event.type === "thread.turn-diff-completed");
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(true);
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        "README.md",
      ),
    ).toBe("v2\n");
  });
});
