import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, vi } from "vite-plus/test";
import { ProviderDriverKind, type ModelSelection } from "@akeru/contracts";
import type { AkeruMastraState } from "../mastra/AkeruHarnessTypes.ts";
import { reasoningCapabilities } from "../ReasoningOptions.ts";
import { claudeHarnessCapabilities } from "../ClaudeReasoningCapabilities.ts";
import { AgentController } from "../Services/AgentController.ts";
import {
  codexInstanceId,
  codexThreadId,
  codexSelection,
} from "./test-support/agentControllerFixtures.ts";
import {
  makeBridge,
  makeInstanceSnapshot,
  provideController,
} from "./test-support/agentControllerLayers.ts";
import { mastraHarnessFixture } from "./test-support/agentControllerHarness.ts";

const codexStart = {
  threadId: codexThreadId,
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId: codexInstanceId,
  runtimeMode: "approval-required" as const,
};

function reasoningBridge(status: "ready" | "warning", legacy = false, fixed = false) {
  const bridge = makeBridge();

  return {
    ...bridge.service,
    getInstanceInfo: (instanceId: ModelSelection["instanceId"]) =>
      bridge.service.getInstanceInfo(instanceId).pipe(
        Effect.map((info) => ({
          ...info,
          instanceSnapshot: {
            ...makeInstanceSnapshot(instanceId, info.driverKind, {
              models: ["gpt-5.6-sol"],
              status,
            }),
            models: [
              {
                slug: "gpt-5.6-sol",
                name: "Sol",
                isCustom: false,
                capabilities: legacy
                  ? null
                  : fixed
                    ? { optionDescriptors: [] }
                    : reasoningCapabilities(info.driverKind, "gpt-5.6-sol", {
                        id: "gpt-5.6-sol",
                        name: "Sol",
                        efforts: ["none", "low", "high"],
                      }),
              },
            ],
          },
        })),
      ),
  };
}

const resolve = (
  controller: AgentController["Service"],
  model: string,
  options?: ModelSelection["options"],
  provider = "codex",
) =>
  controller.resolveEngine({
    threadId: codexThreadId,
    engine: { provider, model, ...(options ? { options } : {}) },
    fallback: codexSelection,
    mode: "default",
    botConversation: true,
  });

describe("effective bot reasoning at the controller boundary", () => {
  it.effect(
    "rejects invalid bot override options from a settled snapshot and preserves unrelated option ids",
    () => {
      const mastra = mastraHarnessFixture();
      const bridge = reasoningBridge("ready");

      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;

          const failure = yield* Effect.flip(
            resolve(controller, "gpt-5.6-sol", [{ id: "reasoningEffort", value: "medium" }]),
          );

          expect(failure._tag).toBe("ProviderValidationError");

          const valid = yield* resolve(controller, "gpt-5.6-sol", [
            { id: "reasoningEffort", value: "off" },
            { id: "futureOption", value: "custom" },
          ]);

          expect(valid.modelSelection.options).toEqual([
            { id: "reasoningEffort", value: "off" },
            { id: "futureOption", value: "custom" },
          ]);
        }),
        bridge,
        mastra.factory,
      );
    },
  );

  it.effect("rejects stale reasoning on a settled fixed model after the bot override", () => {
    const mastra = mastraHarnessFixture();

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;

        const failure = yield* Effect.flip(
          resolve(controller, "gpt-5.6-sol", [{ id: "reasoningEffort", value: "high" }]),
        );

        expect(failure._tag).toBe("ProviderValidationError");
        expect(mastra.createSession).not.toHaveBeenCalled();

        const reset = yield* resolve(controller, "gpt-5.6-sol", [
          { id: "reasoningEffort", value: "default" },
        ]);

        expect(reset.modelSelection.model).toBe("gpt-5.6-sol");
      }),
      reasoningBridge("ready", false, true),
      mastra.factory,
    );
  });

  it.effect.each([
    { status: "warning", legacy: false },
    { status: "ready", legacy: true },
  ] as const)("handles $status / legacy=$legacy snapshots gracefully", ({ status, legacy }) => {
    const mastra = mastraHarnessFixture();

    return provideController(
      Effect.gen(function* () {
        const controller = yield* AgentController;

        const resolved = yield* resolve(controller, "gpt-5.6-sol", [
          { id: "reasoningEffort", value: "medium" },
        ]);

        expect(resolved.modelSelection.options).toEqual([
          { id: "reasoningEffort", value: "medium" },
        ]);
      }),
      reasoningBridge(status, legacy),
      mastra.factory,
    );
  });

  it.effect(
    "replaces provider options in merged state and clears them on reset and session reuse",
    () => {
      const mastra = mastraHarnessFixture();
      const bridge = makeBridge();
      let state: AkeruMastraState = {};
      mastra.session.state.get = () => state;
      vi.spyOn(mastra.session.state, "set").mockImplementation(async (updates) => {
        state = { ...state, ...updates };
      });

      return provideController(
        Effect.gen(function* () {
          const controller = yield* AgentController;
          yield* resolve(controller, "gpt-5.6-sol", [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "priority" },
          ]);
          yield* controller.startSession(codexThreadId, codexStart);

          expect(state.modelOptions).toEqual({ reasoningEffort: "high", serviceTier: "priority" });
          yield* resolve(
            controller,
            "claude-opus-5-5",
            [{ id: "effort", value: "low" }],
            "claudeAgent",
          );

          expect(state.modelOptions).toEqual({
            namespace: "anthropic",
            effort: "low",
            thinking: true,
            thinkingMode: "adaptive",
          });
          yield* resolve(
            controller,
            "claude-haiku-4-5",
            [{ id: "thinking", value: false }],
            "claudeAgent",
          );

          expect(state.modelOptions).toEqual({
            namespace: "anthropic",
            thinking: false,
            thinkingMode: "enabled",
          });
          yield* resolve(controller, "gpt-5.6-sol", [{ id: "reasoningEffort", value: "default" }]);
          yield* controller.startSession(codexThreadId, codexStart);

          expect(state.modelOptions).toEqual({});
          expect(
            claudeHarnessCapabilities("claude-opus-4-5", {
              id: "claude-opus-4-5",
              name: "Opus",
              efforts: ["low", "medium", "high"],
            }).optionDescriptors?.find((option) => option.id === "thinking"),
          ).toBeUndefined();
        }),
        bridge.service,
        mastra.factory,
      );
    },
  );
});
