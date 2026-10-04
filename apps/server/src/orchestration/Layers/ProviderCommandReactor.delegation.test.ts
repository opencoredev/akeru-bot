import { ProviderDriverKind, ProviderInstanceId } from "@akeru/contracts";
import {
  BotId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DelegationId,
  ThreadId,
  TurnId,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect, vi } from "vite-plus/test";
import { AgentControllerRuntimeError, ProviderAdapterRequestError } from "../../provider/Errors.ts";
import { type AgentControllerShape } from "../../provider/Services/AgentController.ts";
import {
  asProjectId,
  createProviderCommandHarness,
} from "./test-support/ProviderCommandHarness.ts";

describe("ProviderCommandReactor", () => {
  const testScope = createProviderCommandHarness();
  const { createHarness } = testScope;
  afterEach(testScope.dispose);
  effectIt.effect("interrupts canceled delegation children and preserves kept children", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() => createHarness({ botEngine: null }));
      const now = "2026-01-01T00:00:00.000Z";
      const later = "2026-01-01T00:00:01.000Z";
      const parentBotId = BotId.make("bot-1");
      const childBotId = BotId.make("bot-child");

      yield* harness.engine.dispatch({
        type: "bot.create",
        commandId: CommandId.make("cmd-delegation-child-bot"),
        botId: childBotId,
        name: "Child bot",
        title: "Child bot",
        avatar: { kind: "dither", seed: "child-bot" },
        engine: null,
        sandbox: "local",
        runtimeMode: "approval-required",
        groupId: null,
        createdAt: now,
      });

      const createDelegation = (suffix: string) =>
        Effect.gen(function* () {
          const childThreadId = ThreadId.make(`delegation-child-${suffix}`);
          const childTurnId = TurnId.make(`delegation-turn-${suffix}`);
          const delegationId = DelegationId.make(`delegation-${suffix}`);
          yield* harness.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`cmd-delegation-thread-${suffix}`),
            threadId: childThreadId,
            projectId: asProjectId("project-1"),
            botId: childBotId,
            title: "Delegated work",
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
            commandId: CommandId.make(`cmd-delegation-create-${suffix}`),
            delegation: queued,
          });
          yield* harness.engine.dispatch({
            type: "delegation.state.set",
            commandId: CommandId.make(`cmd-delegation-running-${suffix}`),
            delegation: {
              ...queued,
              phase: {
                _tag: "Running",
                childThreadId,
                childTurnId,
                startedAt: now,
                progress: null,
              },
            },
          });

          return { delegationId, childThreadId, childTurnId };
        });

      const kept = yield* createDelegation("kept");
      yield* harness.engine.dispatch({
        type: "delegation.cancel",
        commandId: CommandId.make("cmd-delegation-keep"),
        delegationId: kept.delegationId,
        keep: true,
        createdAt: later,
      });
      yield* Effect.promise(() => harness.drain());
      expect(harness.interruptTurn).not.toHaveBeenCalled();

      const canceled = yield* createDelegation("canceled");
      yield* harness.engine.dispatch({
        type: "delegation.cancel",
        commandId: CommandId.make("cmd-delegation-cancel"),
        delegationId: canceled.delegationId,
        keep: false,
        createdAt: later,
      });
      yield* Effect.promise(() => harness.drain());
      expect(harness.interruptTurn).toHaveBeenCalledWith({
        threadId: canceled.childThreadId,
        turnId: canceled.childTurnId,
      });
    }),
  );

  effectIt.effect("keeps a cancel when the stopped child cannot be interrupted", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({
          botEngine: null,
          interruptTurnEffect: () =>
            Effect.fail(
              new ProviderAdapterRequestError({
                provider: ProviderDriverKind.make("codex"),
                method: "thread.turn.interrupt",
                detail: "No active session.",
              }),
            ),
        }),
      );

      const now = "2026-01-01T00:00:00.000Z";
      const later = "2026-01-01T00:00:01.000Z";
      const parentBotId = BotId.make("bot-1");
      const childBotId = BotId.make("bot-child");
      const childThreadId = ThreadId.make("delegation-child-stopped");
      const delegationId = DelegationId.make("delegation-stopped-child");

      yield* harness.engine.dispatch({
        type: "bot.create",
        commandId: CommandId.make("cmd-stopped-child-bot"),
        botId: childBotId,
        name: "Child bot",
        title: "Child bot",
        avatar: { kind: "dither", seed: "child-bot" },
        engine: null,
        sandbox: "local",
        runtimeMode: "approval-required",
        groupId: null,
        createdAt: now,
      });
      yield* harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-stopped-child-thread"),
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
        task: "Audit the docs site for broken links.",
        expectedResult: "A list of broken links.",
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
        keep: true,
        anchorMessageId: null,
        retryOfDelegationId: null,
        trigger: "bot" as const,
        createdAt: now,
        updatedAt: now,
      };

      yield* harness.engine.dispatch({
        type: "delegation.create",
        commandId: CommandId.make("cmd-stopped-child-create"),
        delegation: queued,
      });
      yield* harness.engine.dispatch({
        type: "delegation.state.set",
        commandId: CommandId.make("cmd-stopped-child-running"),
        delegation: {
          ...queued,
          phase: {
            _tag: "Running",
            childThreadId,
            childTurnId: null,
            startedAt: now,
            progress: null,
          },
        },
      });

      yield* harness.engine.dispatch({
        type: "delegation.cancel",
        commandId: CommandId.make("cmd-stopped-child-cancel"),
        delegationId,
        keep: false,
        createdAt: later,
      });
      yield* Effect.promise(() => harness.drain());

      expect(harness.interruptTurn).toHaveBeenCalledWith({ threadId: childThreadId });

      const delegation = (yield* Effect.promise(() => harness.readModel())).delegations.find(
        (entry) => entry.delegationId === delegationId,
      );

      expect(delegation?.phase).toMatchObject({
        _tag: "Canceled",
        childThreadId,
        completedAt: later,
        canceledBy: "user",
      });
    }),
  );

  effectIt.effect("hands a retry to the delegation runtime and reports a refused start", () =>
    Effect.gen(function* () {
      const dispatchDelegation = vi.fn((input: { readonly delegationId?: DelegationId }) =>
        input.delegationId === DelegationId.make("delegation-refused")
          ? Effect.fail(
              new AgentControllerRuntimeError({
                operation: "dispatchDelegation",
                detail: "The target bot is not available in this workspace.",
              }),
            )
          : Effect.succeed({
              delegationId: DelegationId.make("delegation-retry"),
              childThreadId: ThreadId.make("delegation-thread-retry"),
              childBotId: BotId.make("bot-child"),
              name: "Child bot",
              phase: "running" as const,
            }),
      );

      const harness = yield* Effect.promise(() =>
        createHarness({
          botEngine: null,
          dispatchDelegation: dispatchDelegation as AgentControllerShape["dispatchDelegation"],
        }),
      );

      const now = "2026-01-01T00:00:00.000Z";
      const later = "2026-01-01T00:00:01.000Z";
      const parentBotId = BotId.make("bot-1");
      const childBotId = BotId.make("bot-child");
      yield* harness.engine.dispatch({
        type: "bot.create",
        commandId: CommandId.make("cmd-retry-child-bot"),
        botId: childBotId,
        name: "Child bot",
        title: "Child bot",
        avatar: { kind: "dither", seed: "child-bot" },
        engine: null,
        sandbox: "local",
        runtimeMode: "approval-required",
        groupId: null,
        createdAt: now,
      });

      const createFailed = (suffix: string) =>
        Effect.gen(function* () {
          const queued = {
            delegationId: DelegationId.make(`delegation-${suffix}`),
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
            commandId: CommandId.make(`cmd-retry-create-${suffix}`),
            delegation: queued,
          });
          yield* harness.engine.dispatch({
            type: "delegation.state.set",
            commandId: CommandId.make(`cmd-retry-failed-${suffix}`),
            delegation: {
              ...queued,
              phase: {
                _tag: "Failed",
                childThreadId: null,
                childTurnId: null,
                startedAt: null,
                completedAt: now,
                failure: { failureCode: "child_failed", message: "The child failed." },
                acknowledgedAt: null,
              },
            },
          });

          return queued.delegationId;
        });

      const original = yield* createFailed("original");
      const before = (yield* Effect.promise(() => harness.readModel())).delegations;
      yield* harness.engine.dispatch({
        type: "delegation.retry",
        commandId: CommandId.make("cmd-retry"),
        delegationId: original,
        createdAt: later,
      });
      yield* Effect.promise(() => harness.drain());
      expect(dispatchDelegation).toHaveBeenCalledWith({ _tag: "Retry", delegationId: original });
      expect((yield* Effect.promise(() => harness.readModel())).delegations).toEqual(before);

      const refused = yield* createFailed("refused");
      yield* harness.engine.dispatch({
        type: "delegation.retry",
        commandId: CommandId.make("cmd-retry-refused"),
        delegationId: refused,
        createdAt: later,
      });
      yield* Effect.promise(() => harness.drain());

      const parentThread = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (thread) => thread.id === ThreadId.make("thread-1"),
      );

      expect(
        parentThread?.activities.find((activity) => activity.kind === "delegation.retry.failed"),
      ).toMatchObject({
        tone: "error",
        summary: "Bot work could not be retried",
        payload: { detail: "The target bot is not available in this workspace." },
      });
    }),
  );
});
