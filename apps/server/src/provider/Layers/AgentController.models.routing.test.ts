import { sessionFixture } from "./test-support/partialFixtures.ts";

import { ProviderDriverKind, ThreadId } from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, vi } from "vite-plus/test";
import { AgentController } from "../Services/AgentController.ts";
import { type AgentControllerLiveOptions } from "./AgentController.ts";
import { codexInstanceId } from "./test-support/agentControllerFixtures.ts";
import { makeBridge, provideController } from "./test-support/agentControllerLayers.ts";

describe("AgentControllerLive", () => {
  describe("per-driver wire-format model routing", () => {
    it.effect("routes two bots on the same Codex instance to different models", () => {
      const bridge = makeBridge();

      const sessionsByThread = new Map<
        string,
        {
          model: { switch: ReturnType<typeof vi.fn> };
          sendMessage: ReturnType<typeof vi.fn>;
        }
      >();

      const factory: NonNullable<AgentControllerLiveOptions["makeMastraHarness"]> = () =>
        Effect.succeed({
          controller: {
            init: vi.fn(async () => undefined),
            createSession: vi.fn(async (input: { readonly id: string }) => {
              const switchSpy = vi.fn(async () => undefined);
              const sendMessage = vi.fn(() => Promise.resolve());
              sessionsByThread.set(input.id, {
                model: { switch: switchSpy },
                sendMessage,
              });

              return sessionFixture({
                state: {
                  get: () => ({}),
                  set: vi.fn(async () => undefined),
                },
                mode: {
                  get: () => "build",
                  switch: vi.fn(async () => undefined),
                },
                model: { get: () => "", switch: switchSpy },
                permissions: {
                  setForCategory: vi.fn(async () => undefined),
                  setForTool: vi.fn(async () => undefined),
                },
                grantTool: vi.fn(),
                subscribe: vi.fn(() => () => undefined),
                sendMessage,
                abort: vi.fn(),
                respondToToolApproval: vi.fn(),
                respondToToolSuspension: vi.fn(async () => undefined),
              });
            }),
            deleteSession: vi.fn(async () => true),
          },
          observeExternalTurn: vi.fn(async () => undefined),
        });

      const codexWorkThread = ThreadId.make("thread-codex-work");
      const codexReviewThread = ThreadId.make("thread-codex-review");

      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;

          for (const [threadId, model] of [
            [codexWorkThread, "gpt-5.6-sol"],
            [codexReviewThread, "gpt-5.6-codex-mini"],
          ] as const) {
            yield* controller.resolveEngine({
              threadId,
              engine: { provider: "codex", model },
              fallback: { instanceId: codexInstanceId, model },
              mode: "default",
              botConversation: true,
            });
            yield* controller.startSession(threadId, {
              threadId,
              provider: ProviderDriverKind.make("codex"),
              providerInstanceId: codexInstanceId,
              cwd: process.cwd(),
              modelSelection: { instanceId: codexInstanceId, model },
              runtimeMode: "approval-required",
            });
            yield* controller.sendTurn({ threadId, input: `Use ${model}.` });
          }

          expect(sessionsByThread.get(String(codexWorkThread))?.model.switch).toHaveBeenCalledWith({
            modelId: "openai/gpt-5.6-sol",
          });
          expect(
            sessionsByThread.get(String(codexReviewThread))?.model.switch,
          ).toHaveBeenCalledWith({ modelId: "openai/gpt-5.6-codex-mini" });
          expect(sessionsByThread.get(String(codexWorkThread))?.sendMessage).toHaveBeenCalledWith({
            content: "Use gpt-5.6-sol.",
          });
          expect(sessionsByThread.get(String(codexReviewThread))?.sendMessage).toHaveBeenCalledWith(
            { content: "Use gpt-5.6-codex-mini." },
          );
          expect(bridge.startSession).not.toHaveBeenCalled();
          expect(bridge.sendTurn).not.toHaveBeenCalled();
        }),
        bridge.service,
        factory,
      );
    });
  });
});
