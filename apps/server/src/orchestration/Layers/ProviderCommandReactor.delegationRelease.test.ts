import { ProviderInstanceId } from "@akeru/contracts";
import {
  BotId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DelegationId,
  ThreadId,
  TurnId,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect } from "vite-plus/test";
import {
  asProjectId,
  asMessageId,
  awaitDomainEvent,
  releasesDelegation,
  createProviderCommandHarness,
} from "./test-support/ProviderCommandHarness.ts";

describe("ProviderCommandReactor", () => {
  const testScope = createProviderCommandHarness();
  const { createHarness } = testScope;
  afterEach(testScope.dispose);
  effectIt.effect("hands delegated results back when the parent turn fails to start", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() => createHarness({ botEngine: null }));
      const now = "2026-01-01T00:00:00.000Z";
      const parentBotId = BotId.make("bot-1");
      const childBotId = BotId.make("bot-child");
      const childThreadId = ThreadId.make("delegation-child-release");
      const childTurnId = TurnId.make("delegation-turn-release");
      const delegationId = DelegationId.make("delegation-release");

      yield* harness.engine.dispatch({
        type: "bot.create",
        commandId: CommandId.make("cmd-release-child-bot"),
        botId: childBotId,
        name: "Child bot",
        title: "Child bot",
        avatar: { kind: "dither", seed: "child-bot" },
        engine: null,
        sandbox: "local",
        runtimeMode: "approval-required",
        usageCap: null,
        groupId: null,
        createdAt: now,
      });
      yield* harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-release-child-thread"),
        threadId: childThreadId,
        projectId: asProjectId("project-1"),
        botId: childBotId,
        title: "Delegated work",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });

      const queued = {
        delegationId,
        parentDelegationId: null,
        parentBotId,
        childBotId,
        parentThreadId: ThreadId.make("thread-1"),
        parentTurnId: TurnId.make("turn-parent"),
        ancestorBotIds: [parentBotId],
        depth: 1,
        task: "Research the answer.",
        expectedResult: "A concise answer.",
        deadline: null,
        access: {
          allowedToolIds: ["Read" as const],
          memoryScopes: [],
          sandbox: "local" as const,
          runtimeMode: "approval-required" as const,
          hasUserComputer: false,
          enabledMcpServerIds: [],
          disabledMcpServerIds: [],
          approvalCeiling: "send" as const,
        },
        phase: { _tag: "Queued" as const },
        billedBotId: childBotId,
        keep: false,
        anchorMessageId: null,
        retryOfDelegationId: null,
        trigger: "bot" as const,
        createdAt: now,
        updatedAt: now,
      };

      yield* harness.engine.dispatch({
        type: "delegation.create",
        commandId: CommandId.make("cmd-release-create"),
        delegation: queued,
      });

      const running = {
        _tag: "Running" as const,
        childThreadId,
        childTurnId,
        startedAt: now,
        progress: null,
      };

      yield* harness.engine.dispatch({
        type: "delegation.state.set",
        commandId: CommandId.make("cmd-release-running"),
        delegation: { ...queued, phase: running },
      });
      yield* harness.engine.dispatch({
        type: "delegation.state.set",
        commandId: CommandId.make("cmd-release-completed"),
        delegation: {
          ...queued,
          phase: {
            _tag: "Completed",
            childThreadId,
            childTurnId,
            startedAt: now,
            completedAt: now,
            acknowledgedAt: null,
            result: { summary: "The answer is 42.", childThreadId, childTurnId },
          },
        },
      });

      const startTurn = (suffix: string, createdAt: string) =>
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`cmd-release-turn-${suffix}`),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId(`user-message-release-${suffix}`),
            role: "user",
            text: "What did the child find?",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        });

      // The failed send recovers in its own fiber, so wait for the release
      // event it publishes rather than the reactor drain.
      const released = yield* awaitDomainEvent(harness.engine, releasesDelegation(delegationId));
      harness.sendTurn.mockImplementationOnce(() => Effect.die("dispatch failed"));
      yield* startTurn("failed", "2026-01-01T00:00:02.000Z");
      yield* Fiber.join(released);

      yield* startTurn("retry", "2026-01-01T00:00:03.000Z");
      yield* Effect.promise(() => harness.drain());
      expect(harness.sendTurn).toHaveBeenCalledTimes(2);
      expect(harness.sendTurn.mock.calls.at(-1)?.[0]).toMatchObject({
        delegationResults: expect.stringContaining("The answer is 42."),
      });
    }).pipe(Effect.scoped),
  );

  effectIt.effect("hands delegated results back when they cannot be read for a started turn", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() => createHarness({ botEngine: null }));
      const now = "2026-01-01T00:00:00.000Z";
      const parentBotId = BotId.make("bot-1");
      const childBotId = BotId.make("bot-child");
      const childThreadId = ThreadId.make("delegation-child-unread");
      const childTurnId = TurnId.make("delegation-turn-unread");
      const delegationId = DelegationId.make("delegation-unread");

      yield* harness.engine.dispatch({
        type: "bot.create",
        commandId: CommandId.make("cmd-unread-child-bot"),
        botId: childBotId,
        name: "Child bot",
        title: "Child bot",
        avatar: { kind: "dither", seed: "child-bot" },
        engine: null,
        sandbox: "local",
        runtimeMode: "approval-required",
        usageCap: null,
        groupId: null,
        createdAt: now,
      });
      yield* harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-unread-child-thread"),
        threadId: childThreadId,
        projectId: asProjectId("project-1"),
        botId: childBotId,
        title: "Delegated work",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });

      const queued = {
        delegationId,
        parentDelegationId: null,
        parentBotId,
        childBotId,
        parentThreadId: ThreadId.make("thread-1"),
        parentTurnId: TurnId.make("turn-parent"),
        ancestorBotIds: [parentBotId],
        depth: 1,
        task: "Research the answer.",
        expectedResult: "A concise answer.",
        deadline: null,
        access: {
          allowedToolIds: ["Read" as const],
          memoryScopes: [],
          sandbox: "local" as const,
          runtimeMode: "approval-required" as const,
          hasUserComputer: false,
          enabledMcpServerIds: [],
          disabledMcpServerIds: [],
          approvalCeiling: "send" as const,
        },
        phase: { _tag: "Queued" as const },
        billedBotId: childBotId,
        keep: false,
        anchorMessageId: null,
        retryOfDelegationId: null,
        trigger: "bot" as const,
        createdAt: now,
        updatedAt: now,
      };

      yield* harness.engine.dispatch({
        type: "delegation.create",
        commandId: CommandId.make("cmd-unread-create"),
        delegation: queued,
      });

      const running = {
        _tag: "Running" as const,
        childThreadId,
        childTurnId,
        startedAt: now,
        progress: null,
      };

      yield* harness.engine.dispatch({
        type: "delegation.state.set",
        commandId: CommandId.make("cmd-unread-running"),
        delegation: { ...queued, phase: running },
      });
      yield* harness.engine.dispatch({
        type: "delegation.state.set",
        commandId: CommandId.make("cmd-unread-completed"),
        delegation: {
          ...queued,
          phase: {
            _tag: "Completed",
            childThreadId,
            childTurnId,
            startedAt: now,
            completedAt: now,
            acknowledgedAt: null,
            result: { summary: "The answer is 42.", childThreadId, childTurnId },
          },
        },
      });

      const startTurn = (suffix: string, createdAt: string) =>
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`cmd-unread-turn-${suffix}`),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId(`user-message-unread-${suffix}`),
            role: "user",
            text: "What did the child find?",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        });

      // Both attempts at the results read fail, and so does the release's
      // first read. The release retries its read, then the send proceeds.
      harness.failNextCommandReadModelReads(3);
      yield* startTurn("unread", "2026-01-01T00:00:02.000Z");
      yield* Effect.promise(() => harness.drain());
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      expect(harness.sendTurn.mock.calls[0]?.[0]).not.toHaveProperty("delegationResults");
      const readModel = yield* Effect.promise(() => harness.readModel());
      expect(
        readModel.delegations.find((delegation) => delegation.delegationId === delegationId)?.phase,
      ).toMatchObject({ _tag: "Completed", acknowledgedAt: null });

      yield* startTurn("retry", "2026-01-01T00:00:03.000Z");
      yield* Effect.promise(() => harness.drain());
      expect(harness.sendTurn).toHaveBeenCalledTimes(2);
      expect(harness.sendTurn.mock.calls.at(-1)?.[0]).toMatchObject({
        delegationResults: expect.stringContaining("The answer is 42."),
      });
    }),
  );

  effectIt.effect("fails the turn start until unreleased delegated results are handed back", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() => createHarness({ botEngine: null }));
      const now = "2026-01-01T00:00:00.000Z";
      const parentBotId = BotId.make("bot-1");
      const childBotId = BotId.make("bot-child");
      const childThreadId = ThreadId.make("delegation-child-unreleased");
      const childTurnId = TurnId.make("delegation-turn-unreleased");
      const delegationId = DelegationId.make("delegation-unreleased");

      yield* harness.engine.dispatch({
        type: "bot.create",
        commandId: CommandId.make("cmd-unreleased-child-bot"),
        botId: childBotId,
        name: "Child bot",
        title: "Child bot",
        avatar: { kind: "dither", seed: "child-bot" },
        engine: null,
        sandbox: "local",
        runtimeMode: "approval-required",
        usageCap: null,
        groupId: null,
        createdAt: now,
      });
      yield* harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-unreleased-child-thread"),
        threadId: childThreadId,
        projectId: asProjectId("project-1"),
        botId: childBotId,
        title: "Delegated work",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });

      const queued = {
        delegationId,
        parentDelegationId: null,
        parentBotId,
        childBotId,
        parentThreadId: ThreadId.make("thread-1"),
        parentTurnId: TurnId.make("turn-parent"),
        ancestorBotIds: [parentBotId],
        depth: 1,
        task: "Research the answer.",
        expectedResult: "A concise answer.",
        deadline: null,
        access: {
          allowedToolIds: ["Read" as const],
          memoryScopes: [],
          sandbox: "local" as const,
          runtimeMode: "approval-required" as const,
          hasUserComputer: false,
          enabledMcpServerIds: [],
          disabledMcpServerIds: [],
          approvalCeiling: "send" as const,
        },
        phase: { _tag: "Queued" as const },
        billedBotId: childBotId,
        keep: false,
        anchorMessageId: null,
        retryOfDelegationId: null,
        trigger: "bot" as const,
        createdAt: now,
        updatedAt: now,
      };

      yield* harness.engine.dispatch({
        type: "delegation.create",
        commandId: CommandId.make("cmd-unreleased-create"),
        delegation: queued,
      });

      const running = {
        _tag: "Running" as const,
        childThreadId,
        childTurnId,
        startedAt: now,
        progress: null,
      };

      yield* harness.engine.dispatch({
        type: "delegation.state.set",
        commandId: CommandId.make("cmd-unreleased-running"),
        delegation: { ...queued, phase: running },
      });
      yield* harness.engine.dispatch({
        type: "delegation.state.set",
        commandId: CommandId.make("cmd-unreleased-completed"),
        delegation: {
          ...queued,
          phase: {
            _tag: "Completed",
            childThreadId,
            childTurnId,
            startedAt: now,
            completedAt: now,
            acknowledgedAt: null,
            result: { summary: "The answer is 42.", childThreadId, childTurnId },
          },
        },
      });

      const startTurn = (suffix: string, createdAt: string) =>
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`cmd-unreleased-turn-${suffix}`),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId(`user-message-unreleased-${suffix}`),
            role: "user",
            text: "What did the child find?",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        });

      // The results read fails twice and every quick release attempt fails,
      // so the turn must not run without them. The background retry then
      // hands them back to the next turn.
      const released = yield* awaitDomainEvent(harness.engine, releasesDelegation(delegationId));
      harness.failNextCommandReadModelReads(2);
      harness.failNextDelegationReleases(9);
      yield* startTurn("unreleased", "2026-01-01T00:00:02.000Z");
      yield* Effect.promise(() => harness.drain());
      const readModel = yield* Effect.promise(() => harness.readModel());
      expect(
        readModel.threads
          .find((thread) => thread.id === ThreadId.make("thread-1"))
          ?.activities.some((activity) => activity.kind === "provider.turn.start.failed"),
      ).toBe(true);
      expect(harness.sendTurn).not.toHaveBeenCalled();
      // The background retry publishes the release once a dispatch lands.
      yield* Fiber.join(released);

      yield* startTurn("retry", "2026-01-01T00:00:03.000Z");
      yield* Effect.promise(() => harness.drain());
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      expect(harness.sendTurn.mock.calls.at(-1)?.[0]).toMatchObject({
        delegationResults: expect.stringContaining("The answer is 42."),
      });
    }).pipe(Effect.scoped),
  );

  effectIt.effect("hands delegated results back after a restart cancels their release", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({ botEngine: null, startReactor: false }),
      );

      const now = "2026-01-01T00:00:00.000Z";
      const parentBotId = BotId.make("bot-1");
      const childBotId = BotId.make("bot-child");
      const childThreadId = ThreadId.make("delegation-child-restart");
      const childTurnId = TurnId.make("delegation-turn-restart");
      const delegationId = DelegationId.make("delegation-restart");

      yield* harness.engine.dispatch({
        type: "bot.create",
        commandId: CommandId.make("cmd-restart-child-bot"),
        botId: childBotId,
        name: "Child bot",
        title: "Child bot",
        avatar: { kind: "dither", seed: "child-bot" },
        engine: null,
        sandbox: "local",
        runtimeMode: "approval-required",
        usageCap: null,
        groupId: null,
        createdAt: now,
      });
      yield* harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-restart-child-thread"),
        threadId: childThreadId,
        projectId: asProjectId("project-1"),
        botId: childBotId,
        title: "Delegated work",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });

      const queued = {
        delegationId,
        parentDelegationId: null,
        parentBotId,
        childBotId,
        parentThreadId: ThreadId.make("thread-1"),
        parentTurnId: TurnId.make("turn-parent"),
        ancestorBotIds: [parentBotId],
        depth: 1,
        task: "Research the answer.",
        expectedResult: "A concise answer.",
        deadline: null,
        access: {
          allowedToolIds: ["Read" as const],
          memoryScopes: [],
          sandbox: "local" as const,
          runtimeMode: "approval-required" as const,
          hasUserComputer: false,
          enabledMcpServerIds: [],
          disabledMcpServerIds: [],
          approvalCeiling: "send" as const,
        },
        phase: { _tag: "Queued" as const },
        billedBotId: childBotId,
        keep: false,
        anchorMessageId: null,
        retryOfDelegationId: null,
        trigger: "bot" as const,
        createdAt: now,
        updatedAt: now,
      };

      yield* harness.engine.dispatch({
        type: "delegation.create",
        commandId: CommandId.make("cmd-restart-create"),
        delegation: queued,
      });

      const running = {
        _tag: "Running" as const,
        childThreadId,
        childTurnId,
        startedAt: now,
        progress: null,
      };

      yield* harness.engine.dispatch({
        type: "delegation.state.set",
        commandId: CommandId.make("cmd-restart-running"),
        delegation: { ...queued, phase: running },
      });
      yield* harness.engine.dispatch({
        type: "delegation.state.set",
        commandId: CommandId.make("cmd-restart-completed"),
        delegation: {
          ...queued,
          phase: {
            _tag: "Completed",
            childThreadId,
            childTurnId,
            startedAt: now,
            completedAt: now,
            acknowledgedAt: null,
            result: { summary: "The answer is 42.", childThreadId, childTurnId },
          },
        },
      });

      const startTurn = (suffix: string, createdAt: string) =>
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`cmd-restart-turn-${suffix}`),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId(`user-message-restart-${suffix}`),
            role: "user",
            text: "What did the child find?",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        });

      // The results read fails twice and every quick release attempt fails,
      // so the turn must not run without them. The background retry then
      // hands them back to the next turn.
      // The first server fails the turn start and cannot release the results
      // before it stops, which cancels the background retry.
      const firstScope = yield* Scope.make("sequential");
      yield* Effect.promise(() => harness.startReactor(firstScope));

      const failed = yield* awaitDomainEvent(
        harness.engine,
        (event) =>
          event.type === "thread.session-set" &&
          event.payload.threadId === ThreadId.make("thread-1") &&
          event.payload.session.status === "error",
      );

      harness.failNextDelegationReleases(Number.MAX_SAFE_INTEGER);
      harness.sendTurn.mockImplementationOnce(() => Effect.die("dispatch failed"));
      yield* startTurn("failed", "2026-01-01T00:00:02.000Z");
      yield* Fiber.join(failed);
      yield* Scope.close(firstScope, Exit.void);
      const stranded = yield* Effect.promise(() => harness.readModel());
      expect(
        stranded.delegations.find((delegation) => delegation.delegationId === delegationId)?.phase,
      ).toMatchObject({ _tag: "Completed", acknowledgedAt: "2026-01-01T00:00:02.000Z" });

      // The restarted server finds the failed turn start and hands the
      // results back before it handles new work.
      harness.failNextDelegationReleases(0);
      const secondScope = yield* Scope.make("sequential");
      yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void));
      const second = yield* Effect.promise(() => harness.startReactor(secondScope));
      const recovered = yield* Effect.promise(() => harness.readModel());
      expect(
        recovered.delegations.find((delegation) => delegation.delegationId === delegationId)?.phase,
      ).toMatchObject({ _tag: "Completed", acknowledgedAt: null });

      yield* startTurn("retry", "2026-01-01T00:00:03.000Z");
      yield* second.drain;
      expect(harness.sendTurn).toHaveBeenCalledTimes(2);
      expect(harness.sendTurn.mock.calls.at(-1)?.[0]).toMatchObject({
        delegationResults: expect.stringContaining("The answer is 42."),
      });
    }).pipe(Effect.scoped),
  );
});
