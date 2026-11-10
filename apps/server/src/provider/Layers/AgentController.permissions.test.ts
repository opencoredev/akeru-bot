import type { AgentControllerEvent } from "@mastra/core/agent-controller";
import { AKERU_LIST_ROUTINES_TOOL_NAME } from "../AkeruMastraHarness.ts";
import {
  ApprovalRequestId,
  BotId,
  DEFAULT_BOT_PERMISSION_POLICY,
  ProviderDriverKind,
  type BotPermissionPolicy,
  type ThreadId,
} from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { assert, describe, expect } from "vite-plus/test";

import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AgentController } from "../Services/AgentController.ts";
import {
  codexInstanceId,
  codexSelection,
  codexThreadId,
} from "./test-support/agentControllerFixtures.ts";
import {
  makeBridge,
  provideController,
  resolveCodex,
} from "./test-support/agentControllerLayers.ts";
import { mastraHarnessFixture } from "./test-support/agentControllerHarness.ts";
import {
  projectionQueryFixture,
  providerBotFixture,
  providerRuntimeContext,
} from "./test-support/projectionFixtures.ts";

const botId = BotId.make("bot-policy");

describe("AgentControllerLive permission policy", () => {
  it.effect("makes the owner answer a policy ask that full access would approve", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();

    let policy: BotPermissionPolicy = {
      ...DEFAULT_BOT_PERMISSION_POLICY,
      toolOverrides: { Shell: "ask" },
    };

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: process.cwd(),
          modelSelection: codexSelection,
          runtimeMode: "full-access",
          botId,
          botName: "Policy",
        });

        const runtime = mastra.harnessOptions[0]?.toolRuntime;
        assert.isDefined(runtime);

        const opened = yield* controller.streamEvents.pipe(
          Stream.filter((event) => event.type === "request.opened"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true }),
        );

        yield* controller.sendTurn({ threadId: codexThreadId, input: "Run pwd." });
        yield* Effect.yieldNow;
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: "shell-policy-1",
          toolName: "Shell",
          args: { command: "pwd" },
        } as AgentControllerEvent);

        const [request] = yield* Fiber.join(opened);
        expect(request).toMatchObject({
          type: "request.opened",
          payload: { toolName: "Shell" },
        });
        // A policy ask offers no session-wide answer.
        expect(request?.type === "request.opened" ? request.payload.options : []).toEqual([
          { decision: "decline", label: "Decline" },
          { decision: "accept", label: "Approve" },
        ]);
        expect(mastra.session.respondToToolApproval).not.toHaveBeenCalled();

        yield* controller.respondToRequest({
          threadId: codexThreadId,
          requestId: ApprovalRequestId.make("shell-policy-1"),
          decision: "accept",
        });
        expect(mastra.session.respondToToolApproval).toHaveBeenCalledWith({
          toolCallId: "shell-policy-1",
          decision: "approve",
        });

        // The owner revokes Shell before the approved call runs.
        policy = { ...policy, toolOverrides: { Shell: "deny" } };
        yield* Effect.promise(() =>
          expect(
            runtime.execute({
              threadId: String(codexThreadId),
              toolId: "Shell",
              toolCallId: "shell-policy-1",
              input: { command: "pwd" },
              approvalMode: "require-grant",
            }),
          ).rejects.toThrow("not allowed by this bot's permission policy"),
        );
        mastra.finishSend();
      }),
      bridge.service,
      mastra.factory,
    ).pipe(
      Effect.provideService(
        ProjectionSnapshotQuery.ProjectionSnapshotQuery,
        ProjectionSnapshotQuery.ProjectionSnapshotQuery.of(
          projectionQueryFixture({
            getThreadRuntimeContext: (threadId: ThreadId) =>
              Effect.succeed(Option.some(providerRuntimeContext({ id: threadId, botId }))),
            getBotById: () =>
              Effect.sync(() =>
                Option.some(providerBotFixture({ id: botId, permissionPolicy: policy })),
              ),
            getGroupById: () => Effect.succeed(Option.none()),
            listThreadDelegations: () => Effect.succeed([]),
          }),
        ),
      ),
    );
  });

  it.effect("rebuilds the policy when a shared session moves to another responding bot", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();
    const openBot = BotId.make("bot-open");
    const lockedBot = BotId.make("bot-locked");
    let respondingBotId = openBot;

    const policies = new Map<BotId, BotPermissionPolicy>([
      [openBot, DEFAULT_BOT_PERMISSION_POLICY],
      [lockedBot, { ...DEFAULT_BOT_PERMISSION_POLICY, toolOverrides: { Shell: "deny" } }],
    ]);

    const sessionInput = {
      threadId: codexThreadId,
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: codexInstanceId,
      cwd: process.cwd(),
      modelSelection: codexSelection,
      botSandboxBrowserSharing: "shared" as const,
      runtimeMode: "full-access" as const,
    };

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, { ...sessionInput, botId: openBot });

        const runtime = mastra.harnessOptions[0]?.toolRuntime;
        assert.isDefined(runtime);

        yield* Effect.promise(() =>
          expect(
            runtime.requiresApproval(String(codexThreadId), "Shell", { command: "pwd" }),
          ).resolves.toBe(true),
        );

        respondingBotId = lockedBot;
        yield* controller.startSession(codexThreadId, { ...sessionInput, botId: lockedBot });
        // The same Mastra session was reused rather than replaced.
        expect(mastra.createSession).toHaveBeenCalledOnce();

        yield* Effect.promise(() =>
          expect(
            runtime.requiresApproval(String(codexThreadId), "Shell", { command: "pwd" }),
          ).rejects.toThrow("not allowed by this bot's permission policy"),
        );
      }),
      bridge.service,
      mastra.factory,
    ).pipe(
      Effect.provideService(
        ProjectionSnapshotQuery.ProjectionSnapshotQuery,
        ProjectionSnapshotQuery.ProjectionSnapshotQuery.of(
          projectionQueryFixture({
            getThreadRuntimeContext: (threadId: ThreadId) =>
              Effect.sync(() =>
                Option.some(
                  providerRuntimeContext({ id: threadId, botId: openBot, respondingBotId }),
                ),
              ),
            getBotById: (botId: BotId) =>
              Effect.sync(() =>
                Option.some(
                  providerBotFixture({
                    id: botId,
                    permissionPolicy: policies.get(botId) ?? DEFAULT_BOT_PERMISSION_POLICY,
                  }),
                ),
              ),
            getGroupById: () => Effect.succeed(Option.none()),
            listThreadDelegations: () => Effect.succeed([]),
          }),
        ),
      ),
    );
  });

  it.effect("binds an owner answer to a routine listing the policy marks ask", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();

    const policy: BotPermissionPolicy = {
      ...DEFAULT_BOT_PERMISSION_POLICY,
      toolOverrides: { [AKERU_LIST_ROUTINES_TOOL_NAME]: "ask" },
    };

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;
        yield* resolveCodex(controller);
        yield* controller.startSession(codexThreadId, {
          threadId: codexThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: process.cwd(),
          modelSelection: codexSelection,
          runtimeMode: "full-access",
          botId,
          botName: "Policy",
        });

        const runtime = mastra.harnessOptions[0]?.toolRuntime;
        assert.isDefined(runtime);

        const listCall = {
          threadId: String(codexThreadId),
          toolCallId: "list-policy-1",
          toolName: AKERU_LIST_ROUTINES_TOOL_NAME,
          input: {},
        };

        const opened = yield* controller.streamEvents.pipe(
          Stream.filter((event) => event.type === "request.opened"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true }),
        );

        yield* controller.sendTurn({ threadId: codexThreadId, input: "List my routines." });
        yield* Effect.yieldNow;
        yield* Effect.promise(() =>
          expect(
            runtime.requiresNamedApproval(listCall.threadId, listCall.toolName, listCall.input),
          ).resolves.toBe(true),
        );
        mastra.emit({
          type: "tool_approval_required",
          toolCallId: listCall.toolCallId,
          toolName: listCall.toolName,
          args: listCall.input,
        } as AgentControllerEvent);

        // Full access cannot answer for the owner, so the request opens.
        const [request] = yield* Fiber.join(opened);
        expect(request).toMatchObject({ type: "request.opened" });
        expect(mastra.session.respondToToolApproval).not.toHaveBeenCalled();
        yield* Effect.promise(() =>
          expect(runtime.authorizeNamedExecution(listCall)).rejects.toThrow("requires approval"),
        );

        yield* controller.respondToRequest({
          threadId: codexThreadId,
          requestId: ApprovalRequestId.make(listCall.toolCallId),
          decision: "accept",
        });
        expect(mastra.session.respondToToolApproval).toHaveBeenCalledWith({
          toolCallId: listCall.toolCallId,
          decision: "approve",
        });
        yield* Effect.promise(() => runtime.authorizeNamedExecution(listCall));
        yield* Effect.promise(() =>
          expect(runtime.authorizeNamedExecution(listCall)).rejects.toThrow("requires approval"),
        );
        mastra.finishSend();
      }),
      bridge.service,
      mastra.factory,
    ).pipe(
      Effect.provideService(
        ProjectionSnapshotQuery.ProjectionSnapshotQuery,
        ProjectionSnapshotQuery.ProjectionSnapshotQuery.of(
          projectionQueryFixture({
            getThreadRuntimeContext: (threadId: ThreadId) =>
              Effect.succeed(Option.some(providerRuntimeContext({ id: threadId, botId }))),
            getBotById: () =>
              Effect.sync(() =>
                Option.some(providerBotFixture({ id: botId, permissionPolicy: policy })),
              ),
            getGroupById: () => Effect.succeed(Option.none()),
            listThreadDelegations: () => Effect.succeed([]),
          }),
        ),
      ),
    );
  });
});
