import type { AgentControllerEvent } from "@mastra/core/agent-controller";
import {
  ApprovalRequestId,
  BotId,
  DEFAULT_BOT_PERMISSION_POLICY,
  ProviderDriverKind,
  type ThreadId,
} from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { assert, describe, expect, vi } from "vite-plus/test";

import { createEmptyReadModel } from "../../orchestration/projector.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AgentController } from "../Services/AgentController.ts";
import {
  codexInstanceId,
  codexSelection,
  codexThreadId,
} from "./test-support/agentControllerFixtures.ts";
import { makeBridge, makeLayer, resolveCodex } from "./test-support/agentControllerLayers.ts";
import { mastraHarnessFixture } from "./test-support/agentControllerHarness.ts";
import {
  projectionQueryFixture,
  providerBotFixture,
  providerRuntimeContext,
} from "./test-support/projectionFixtures.ts";

const botId = BotId.make("bot-profile");

describe("AgentControllerLive owner approvals", () => {
  it.effect("approves and runs a call whose arguments include a null field", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();

    return Effect.gen(function* () {
      const controller = yield* AgentController;
      yield* resolveCodex(controller);

      // Wires the bot-state tools, so UpdateBotProfile is offered on this bot's session.
      assert.isDefined(controller.configureDelegation);
      yield* controller.configureDelegation({
        readSnapshot: async () => createEmptyReadModel("2026-11-05T10:00:00.000Z"),
        dispatch: async () => ({ sequence: 1 }),
      });
      yield* controller.startSession(codexThreadId, {
        threadId: codexThreadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        cwd: process.cwd(),
        modelSelection: codexSelection,
        runtimeMode: "approval-required",
        botId,
        botName: "Scout",
      });
      yield* controller.sendTurn({ threadId: codexThreadId, input: "Clear your label." });
      yield* Effect.yieldNow;

      // The model sends `label: null`; the approval card shows the call without it.
      mastra.emit({
        type: "tool_approval_required",
        toolCallId: "profile-1",
        toolName: "UpdateBotProfile",
        args: { name: "Scout", label: null },
      } as AgentControllerEvent);
      yield* Effect.yieldNow;

      yield* controller.respondToRequest({
        threadId: codexThreadId,
        requestId: ApprovalRequestId.make("profile-1"),
        decision: "accept",
      });

      expect(mastra.session.respondToToolApproval).toHaveBeenCalledWith({
        toolCallId: "profile-1",
        decision: "approve",
      });

      // The tool runs with null fields dropped, as `AkeruMastraTools` passes them, and the
      // owner's grant must cover that exact call.
      const runtime = mastra.harnessOptions[0]?.toolRuntime;
      assert.isDefined(runtime);

      const outcome = yield* Effect.promise(() =>
        runtime
          .execute({
            threadId: String(codexThreadId),
            toolId: "UpdateBotProfile",
            toolCallId: "profile-1",
            input: { name: "Scout" },
            approvalMode: "require-grant",
          })
          .then(
            () => "ran",
            (error: Error) => error.message,
          ),
      );

      expect(outcome).toBe("ran");
      mastra.finishSend();
    }).pipe(
      Effect.provide(
        makeLayer(bridge.service, mastra.factory, undefined, undefined, undefined, undefined, {
          send: vi.fn(async () => {
            throw new Error("not used");
          }),
          sendToUser: vi.fn(async () => {
            throw new Error("not used");
          }),
          parentFinished: vi.fn(async () => undefined),
          accessForThread: () => undefined,
        }),
      ),
      Effect.orDie,
      Effect.provideService(
        ProjectionSnapshotQuery.ProjectionSnapshotQuery,
        ProjectionSnapshotQuery.ProjectionSnapshotQuery.of(
          projectionQueryFixture({
            getThreadRuntimeContext: (threadId: ThreadId) =>
              Effect.succeed(Option.some(providerRuntimeContext({ id: threadId, botId }))),
            getBotById: () =>
              Effect.succeed(
                Option.some(
                  providerBotFixture({
                    id: botId,
                    permissionPolicy: {
                      ...DEFAULT_BOT_PERMISSION_POLICY,
                      toolOverrides: { UpdateBotProfile: "ask" },
                    },
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
});
