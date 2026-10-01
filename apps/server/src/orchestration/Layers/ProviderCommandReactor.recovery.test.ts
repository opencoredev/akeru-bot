import { ProviderDriverKind, ProviderInstanceId } from "@akeru/contracts";
import { CommandId, DEFAULT_PROVIDER_INTERACTION_MODE, ThreadId } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import {
  asMessageId,
  asProjectId,
  asTurnId,
  asApprovalRequestId,
  createProviderCommandHarness,
} from "./test-support/ProviderCommandHarness.ts";

describe("ProviderCommandReactor", () => {
  const testScope = createProviderCommandHarness();
  const { createHarness } = testScope;
  afterEach(testScope.dispose);
  it("routes thread.turn.start through AgentController before sending the provider turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.run(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-1"),
          role: "user",
          text: "hello reactor",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await harness.waitFor(() => harness.startSession.mock.calls.length === 1);
    await harness.waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.resolveEngine).toHaveBeenCalledWith({
      threadId: ThreadId.make("thread-1"),
      engine: null,
      fallback: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      mode: "default",
      botConversation: false,
    });
    expect(harness.startSession.mock.calls[0]?.[0]).toEqual(ThreadId.make("thread-1"));
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      mcpServers: [],
      memoryAccess: {
        tenantId: "local",
        userId: "owner",
        threadId: "thread-1",
        projectId: "project-1",
        workspaceRoot: "/tmp/provider-project",
        botId: null,
        groupId: null,
        respondingBotId: null,
        groupMemberBotIds: [],
      },
      botSandbox: "local",
      runtimeMode: "approval-required",
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.status).toBe("starting");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  it.each([
    [1, "before"],
    [2, "after"],
  ] as const)(
    "handles an intent committed on startup sequence read %i, %s subscribing",
    async (commitDuringSequenceRead, _position) => {
      const harness = await createHarness({ commitDuringSequenceRead });

      await harness.drain();

      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.titleRegeneration).toBeNull();
    },
  );

  it("replays a startup gap longer than one event store page", async () => {
    const harness = await createHarness({
      commitDuringSequenceRead: 1,
      titleUpdatesBeforeStartupCommit: 1_000,
    });

    await harness.drain();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.titleRegeneration).toBeNull();
  });

  it("fails startup instead of dropping a gap it cannot replay", async () => {
    await expect(
      createHarness({ commitDuringSequenceRead: 1, failStartupReplay: true }),
    ).rejects.toThrow("Injected startup replay failure");
  });

  effectIt.effect("lets another thread approve and interrupt while session setup is blocked", () =>
    Effect.gen(function* () {
      const sessionSetupStarted = yield* Deferred.make<void>();
      const releaseSessionSetup = yield* Deferred.make<void>();
      const approvalReachedAdapter = yield* Deferred.make<void>();
      const interruptReachedAdapter = yield* Deferred.make<void>();
      const threadB = ThreadId.make("thread-2");
      const harness = yield* Effect.promise(() =>
        createHarness({
          startSessionEffect: (session) =>
            session.threadId === ThreadId.make("thread-1")
              ? Deferred.succeed(sessionSetupStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseSessionSetup)),
                  Effect.as(session),
                )
              : Effect.succeed(session),
          respondToRequestEffect: (request) =>
            request.threadId === threadB
              ? Deferred.succeed(approvalReachedAdapter, undefined).pipe(Effect.asVoid)
              : Effect.void,
          interruptTurnEffect: (request) =>
            typeof request === "object" &&
            request !== null &&
            "threadId" in request &&
            request.threadId === threadB
              ? Deferred.succeed(interruptReachedAdapter, undefined).pipe(Effect.asVoid)
              : Effect.void,
        }),
      );
      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create-2-concurrency"),
        threadId: threadB,
        projectId: asProjectId("project-1"),
        title: "Thread B",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });
      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-thread-session-2-concurrency"),
        threadId: threadB,
        session: {
          threadId: threadB,
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-2"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });
      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-blocked-thread-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-blocked-thread-1"),
          role: "user",
          text: "block this setup",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });
      yield* Deferred.await(sessionSetupStarted);

      yield* harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.make("cmd-approval-thread-2-concurrency"),
        threadId: threadB,
        requestId: asApprovalRequestId("approval-thread-2-concurrency"),
        decision: "accept",
        createdAt: now,
      });
      yield* harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-interrupt-thread-2-concurrency"),
        threadId: threadB,
        turnId: asTurnId("turn-2"),
        createdAt: now,
      });

      yield* Deferred.await(approvalReachedAdapter);
      yield* Deferred.await(interruptReachedAdapter);
      expect(yield* Deferred.isDone(releaseSessionSetup)).toBe(false);
      yield* Deferred.succeed(releaseSessionSetup, undefined);
      yield* Effect.promise(() => harness.drain());
    }),
  );

  it("replays a persisted turn start that predates reactor startup exactly once", async () => {
    const harness = await createHarness({ turnStartBeforeReactor: true });

    await harness.drain();

    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      input: "recover this persisted request",
    });
  });

  it("replays a persisted resume that predates reactor startup exactly once", async () => {
    const harness = await createHarness({ resumeBeforeReactor: true });

    await harness.drain();

    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      input: expect.stringContaining("Resume the interrupted request"),
    });
  });

  it("deduplicates a persisted resume delivered by both startup recovery and the live stream", async () => {
    const harness = await createHarness({
      resumeBeforeReactor: true,
      replayPersistedResumeOnSubscribe: true,
    });

    await harness.drain();

    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
  });

  it("continues a running turn after reactor startup without replaying the user prompt", async () => {
    const harness = await createHarness({ runningTurnBeforeReactor: true });

    await harness.drain();

    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      input: expect.stringContaining("server restarted"),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).not.toMatchObject({
      input: "recover this persisted request",
    });
  });

  it.each([
    ["pending turn start", { turnStartBeforeReactor: true }],
    ["pending resume", { resumeBeforeReactor: true }],
    ["running turn", { runningTurnBeforeReactor: true }],
  ] as const)(
    "does not restart a delegated child's %s after reactor startup",
    async (_name, recovery) => {
      const harness = await createHarness({ ...recovery, delegatedChild: true });

      await harness.drain();

      expect(harness.startSession).not.toHaveBeenCalled();
      expect(harness.sendTurn).not.toHaveBeenCalled();
    },
  );

  it("marks an interrupted turn resumable when automatic recovery fails", async () => {
    const harness = await createHarness({
      runningTurnBeforeReactor: true,
      sendTurnEffect: () =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: ProviderDriverKind.make("codex"),
            method: "thread.turn.start",
            detail: "Provider was temporarily unavailable.",
          }),
        ),
    });

    await harness.drain();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session).toMatchObject({
      status: "error",
      lastError: expect.stringContaining("Use Resume to continue"),
    });
    expect(thread?.latestTurn?.state).toBe("error");
  });

  it.each(["approval", "user-input"] as const)(
    "expires a stale pending %s before automatic restart recovery",
    async (requestKind) => {
      const harness = await createHarness({
        runningTurnBeforeReactor: true,
        pendingRequestBeforeReactor: requestKind,
      });

      await harness.drain();

      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.activities).toContainEqual(
        expect.objectContaining({
          kind: requestKind === "approval" ? "approval.resolved" : "user-input.resolved",
          payload: expect.objectContaining({
            requestId: `${requestKind}-before-restart`,
            outcome: "interrupted",
          }),
        }),
      );
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
        input: expect.stringContaining("server restarted"),
      });
    },
  );

  it("resumes an errored turn without adding or replaying a user message", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-before-manual-resume"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-manual-resume"),
          role: "user",
          text: "finish the migration",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-running-before-manual-resume"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          mcpServerIds: [],
          activeTurnId: asTurnId("turn-before-manual-resume"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-error-before-manual-resume"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "error",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          mcpServerIds: [],
          activeTurnId: null,
          lastError: "Automatic recovery failed.",
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    harness.sendTurn.mockClear();

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.resume",
        commandId: CommandId.make("cmd-manual-resume"),
        threadId: ThreadId.make("thread-1"),
        createdAt: now,
      }),
    );
    await harness.drain();

    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      input: expect.stringContaining("Resume the interrupted request"),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).not.toMatchObject({
      input: "finish the migration",
    });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.messages.filter((message) => message.role === "user")).toHaveLength(1);
  });
});
