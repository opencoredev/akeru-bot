import { it as effectIt } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/schema";
import {
  extractModelConfigId,
  parsePermissionRequest,
  parseSessionModeState,
  parseSessionUpdateEvent,
  sessionModelStateFromInitialize,
  syntheticLoadSessionResponseFromInitialize,
  waitForSessionLoadReplayIdle,
  type SessionLoadGate,
} from "./AcpRuntimeModel.ts";

effectIt.effect("finishes session replay at the configured idle deadline", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0);
    const gateRef = yield* Ref.make<Option.Option<SessionLoadGate>>(
      Option.some({
        active: true,
        lastActivityAtMillis: 0,
        idleGap: Duration.millis(101),
        initializeResult: { protocolVersion: 1 },
      }),
    );
    const result = yield* waitForSessionLoadReplayIdle({ gateRef }).pipe(Effect.forkChild);

    yield* TestClock.adjust(Duration.millis(101));

    expect((yield* Fiber.join(result))._meta).toMatchObject({
      t3SessionLoadReady: "replay_idle",
    });
  }),
);

describe("AcpRuntimeModel", () => {
  it("parses session mode state from typed ACP session setup responses", () => {
    const modeState = parseSessionModeState({
      sessionId: "session-1",
      modes: {
        currentModeId: " code ",
        availableModes: [
          { id: " ask ", name: " Ask ", description: " Request approval " },
          { id: " code ", name: " Code " },
        ],
      },
      configOptions: [],
    } satisfies EffectAcpSchema.NewSessionResponse);

    expect(modeState).toEqual({
      currentModeId: "code",
      availableModes: [
        { id: "ask", name: "Ask", description: "Request approval" },
        { id: "code", name: "Code" },
      ],
    });
  });
});

describe("AcpRuntimeModel", () => {
  it("extracts the model config id from typed ACP config options", () => {
    const modelConfigId = extractModelConfigId({
      sessionId: "session-1",
      configOptions: [
        {
          id: "approval",
          name: "Approval Mode",
          category: "permission",
          type: "select",
          currentValue: "ask",
          options: [{ value: "ask", name: "Ask" }],
        },
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "default",
          options: [{ value: "default", name: "Auto" }],
        },
      ],
    } satisfies EffectAcpSchema.NewSessionResponse);

    expect(modelConfigId).toBe("model");
  });
});

describe("AcpRuntimeModel", () => {
  it("reads Grok model state from initialize._meta before a session exists", () => {
    const modelState = sessionModelStateFromInitialize({
      protocolVersion: 1,
      _meta: {
        modelState: {
          currentModelId: "grok-4.6",
          availableModels: [
            { modelId: "grok-4.6", name: "Grok 4.6" },
            { modelId: "grok-mock-alt", name: "Grok Mock Alt" },
          ],
        },
      },
    } satisfies EffectAcpSchema.InitializeResponse);

    expect(modelState?.currentModelId).toBe("grok-4.6");
    expect(modelState?.availableModels.map((model) => model.modelId)).toEqual([
      "grok-4.6",
      "grok-mock-alt",
    ]);
    expect(
      sessionModelStateFromInitialize({
        protocolVersion: 1,
      } satisfies EffectAcpSchema.InitializeResponse),
    ).toBeUndefined();
  });
});

describe("AcpRuntimeModel", () => {
  it("builds a synthetic load response from initialize model state", () => {
    const response = syntheticLoadSessionResponseFromInitialize({
      protocolVersion: 1,
      _meta: {
        modelState: {
          currentModelId: "grok-build",
          availableModels: [{ modelId: "grok-build", name: "Grok Build" }],
        },
      },
    } satisfies EffectAcpSchema.InitializeResponse);

    expect(response.models?.currentModelId).toBe("grok-build");
    expect(response._meta).toMatchObject({ t3SessionLoadReady: "replay_idle" });
  });
});

describe("AcpRuntimeModel", () => {
  it("accepts initialize model descriptions with null", () => {
    const response = syntheticLoadSessionResponseFromInitialize({
      protocolVersion: 1,
      _meta: {
        modelState: {
          currentModelId: "grok-build",
          availableModels: [{ modelId: "grok-build", name: "Grok Build", description: null }],
        },
      },
    } satisfies EffectAcpSchema.InitializeResponse);

    expect(response.models?.availableModels[0]?.description).toBeNull();
  });
});

describe("AcpRuntimeModel", () => {
  it("ignores malformed initialize model state in synthetic load responses", () => {
    const response = syntheticLoadSessionResponseFromInitialize({
      protocolVersion: 1,
      _meta: {
        modelState: {
          currentModelId: "grok-build",
          availableModels: [null],
        },
        modeState: {
          currentModeId: "code",
          availableModes: [{ id: "code", name: 12 }],
        },
      },
    } as EffectAcpSchema.InitializeResponse);

    expect(response.models).toBeUndefined();
    expect(response.modes).toBeUndefined();
    expect(response._meta).toMatchObject({ t3SessionLoadReady: "replay_idle" });
  });
});

describe("AcpRuntimeModel", () => {
  it("builds a synthetic load response with initialize mode state", () => {
    const response = syntheticLoadSessionResponseFromInitialize({
      protocolVersion: 1,
      _meta: {
        modeState: {
          currentModeId: "code",
          availableModes: [
            { id: "ask", name: "Ask" },
            { id: "code", name: "Code" },
          ],
        },
      },
    } satisfies EffectAcpSchema.InitializeResponse);

    expect(response.modes?.currentModeId).toBe("code");
    expect(response.modes?.availableModes).toHaveLength(2);
  });
});

describe("AcpRuntimeModel", () => {
  it("trims padded current mode updates before emitting a mode change", () => {
    const result = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: " code ",
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(result.modeId).toBe("code");
    expect(result.events).toEqual([
      {
        _tag: "ModeChanged",
        modeId: "code",
      },
    ]);
  });
});

describe("AcpRuntimeModel", () => {
  it("keeps permission request parsing compatible with loose extension payloads", () => {
    const request = parsePermissionRequest({
      sessionId: "session-1",
      options: [
        {
          optionId: "allow-once",
          name: "Allow once",
          kind: "allow_once",
        },
      ],
      toolCall: {
        toolCallId: "tool-1",
        title: "`cat package.json`",
        kind: "execute",
        status: "pending",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Not in allowlist",
            },
          },
        ],
      },
    });

    expect(request).toMatchObject({
      kind: "execute",
      detail: "cat package.json",
      toolCall: {
        toolCallId: "tool-1",
        kind: "execute",
        status: "pending",
        command: "cat package.json",
      },
    });
  });
});
