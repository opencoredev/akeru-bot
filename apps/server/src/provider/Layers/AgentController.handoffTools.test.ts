import {
  BotId,
  DEFAULT_BOT_PERMISSION_POLICY,
  ProviderDriverKind,
  ThreadId,
  type AkeruToolReceipt,
} from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { assert, describe, expect, vi } from "vite-plus/test";

import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AgentController } from "../Services/AgentController.ts";
import { approveAsOwner } from "../test-support/AkeruToolRuntime.ts";
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

describe("AgentControllerLive group handoff tools", () => {
  it.effect("sends user messages as the bot a shared session was handed to", () => {
    const bridge = makeBridge();
    const mastra = mastraHarnessFixture();
    const bossBot = BotId.make("bot-boss");
    const specialistBot = BotId.make("bot-specialist");
    let respondingBotId = bossBot;

    const sendToUser = vi.fn(
      async (context: { readonly botId: BotId }): Promise<AkeruToolReceipt> => ({
        receiptId: "tool-message",
        toolId: "SendToUser",
        phase: "success",
        threadId: ThreadId.make(String(codexThreadId)),
        botId: context.botId,
        fatalToThread: false,
        createdAt: "2026-11-05T00:00:00.000Z",
      }),
    );

    const sessionInput = {
      threadId: codexThreadId,
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: codexInstanceId,
      cwd: process.cwd(),
      modelSelection: codexSelection,
      botSandboxBrowserSharing: "shared" as const,
      runtimeMode: "full-access" as const,
    };

    return Effect.gen(function* () {
      const controller = yield* AgentController;
      yield* resolveCodex(controller);
      yield* controller.startSession(codexThreadId, { ...sessionInput, botId: bossBot });

      respondingBotId = specialistBot;
      yield* controller.startSession(codexThreadId, { ...sessionInput, botId: specialistBot });
      // The same Mastra session was reused rather than replaced.
      expect(mastra.createSession).toHaveBeenCalledOnce();

      const runtime = mastra.harnessOptions[0]?.toolRuntime;
      assert.isDefined(runtime);

      yield* controller.sendTurn({ threadId: codexThreadId, input: "Tell the owner." });
      yield* Effect.yieldNow;

      const execution = {
        threadId: String(codexThreadId),
        toolId: "SendToUser" as const,
        toolCallId: "tool-message",
        input: { message: "The export is ready." },
        approvalMode: "require-grant" as const,
      };

      approveAsOwner(runtime, execution);
      yield* Effect.promise(() => runtime.execute(execution));

      expect(sendToUser).toHaveBeenCalledOnce();
      expect(sendToUser.mock.calls[0]?.[0].botId).toBe(specialistBot);
      mastra.finishSend();
    }).pipe(
      Effect.provide(
        makeLayer(bridge.service, mastra.factory, undefined, undefined, undefined, undefined, {
          send: vi.fn(async () => {
            throw new Error("not used");
          }),
          sendToUser,
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
              Effect.sync(() =>
                Option.some(
                  providerRuntimeContext({ id: threadId, botId: bossBot, respondingBotId }),
                ),
              ),
            getBotById: (botId: BotId) =>
              Effect.succeed(
                Option.some(
                  providerBotFixture({
                    id: botId,
                    permissionPolicy: DEFAULT_BOT_PERMISSION_POLICY,
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
