import * as Predicate from "effect/Predicate";
import { describe, expect, it, vi } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ModelSelection } from "@akeru/contracts";
import { AuthStorage } from "@mastra/code-sdk/auth/storage";
import { RequestContext } from "@mastra/core/request-context";
import {
  nativeModelOptions,
  reasoningCapabilities,
  invalidReasoningSelection,
} from "./ReasoningOptions.ts";
import { claudeHarnessCapabilities } from "./ClaudeReasoningCapabilities.ts";
import {
  mastraModelId,
  resolveAkeruMastraModel,
  withAkeruModelRunOptions,
} from "./mastra/AkeruModels.ts";
import { controllerModelOptions } from "./mastra/AkeruMemory.ts";

const selection = (model: string, options?: ModelSelection["options"]): ModelSelection => ({
  instanceId: ProviderInstanceId.make("test"),
  model,
  ...(options ? { options } : {}),
});

const driver = ProviderDriverKind.make;

const auth = new AuthStorage("/tmp/akeru-reasoning-unused-auth.json");

const stopped = new Error("request captured");

async function capturedRequest(
  modelId: string,
  provider: ProviderDriverKind,
  options?: ModelSelection["options"],
  oauth = false,
) {
  let body: unknown;

  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    body = JSON.parse(String(init?.body));
    throw stopped;
  });

  vi.spyOn(auth, "reload").mockImplementation(() => {});
  vi.spyOn(auth, "get").mockReturnValue({
    type: "oauth",
    access: "test-token",
    refresh: "refresh",
    expires: Number.MAX_SAFE_INTEGER,
  });
  vi.spyOn(auth, "getApiKey").mockResolvedValue("test-token");

  try {
    const modelOptions = nativeModelOptions(provider, selection(modelId, options));

    const model = resolveAkeruMastraModel(
      mastraModelId(provider, modelId),
      auth,
      async () => ({ accessToken: "kimi-token" }),
      async () => ({ access: "go-key" }),
      modelOptions,
      oauth ? undefined : () => ({ type: "api-key", access: "test-key" }),
    );

    if (
      !Predicate.isObject(model) ||
      !("specificationVersion" in model) ||
      model.specificationVersion !== "v3"
    )
      throw new Error("Expected a native language model");

    const run = withAkeruModelRunOptions({}, modelOptions ? { modelOptions } : {});

    await expect(
      model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        ...run,
      }),
    ).rejects.toThrow(stopped);
    expect(fetch).toHaveBeenCalledOnce();

    return body;
  } finally {
    vi.restoreAllMocks();
  }
}

describe("native reasoning requests", () => {
  it.each([false, true])(
    "Codex API/OAuth preserves minimal and leaves absent effort to the provider (%s)",
    async (oauth) => {
      expect(
        await capturedRequest(
          "gpt-5",
          driver("codex"),
          [{ id: "reasoningEffort", value: "minimal" }],
          oauth,
        ),
      ).toMatchObject({ reasoning: { effort: "minimal" } });

      const defaultRequest = await capturedRequest(
        "gpt-5",
        driver("codex"),
        [{ id: "reasoningEffort", value: "default" }],
        oauth,
      );

      if (oauth)
        expect(defaultRequest).toMatchObject({
          reasoning: { effort: "medium" },
          store: false,
          instructions: expect.any(String),
        });
      else expect(defaultRequest).not.toHaveProperty("reasoning");
      expect(
        await capturedRequest(
          "gpt-5",
          driver("codex"),
          [{ id: "reasoningEffort", value: "off" }],
          oauth,
        ),
      ).toMatchObject({ reasoning: { effort: "none" } });
    },
  );
  it.each([false, true])(
    "Claude API/OAuth sends native effort and explicit thinking false (%s)",
    async (oauth) => {
      expect(
        await capturedRequest(
          "claude-opus-5-5",
          driver("claudeAgent"),
          [{ id: "effort", value: "xhigh" }],
          oauth,
        ),
      ).toMatchObject({ output_config: { effort: "xhigh" }, thinking: { type: "adaptive" } });
      expect(
        await capturedRequest(
          "claude-haiku-4-5",
          driver("claudeAgent"),
          [{ id: "thinking", value: false }],
          oauth,
        ),
      ).toMatchObject({ thinking: { type: "disabled" } });
      expect(
        await capturedRequest("claude-opus-5-5", driver("claudeAgent"), undefined, oauth),
      ).not.toHaveProperty("thinking");
    },
  );
  it.each([false, true])(
    "Grok API/OAuth sends the compatible native effort (%s)",
    async (oauth) => {
      expect(
        await capturedRequest(
          "grok-4.7",
          driver("grok"),
          [{ id: "reasoningEffort", value: "high" }],
          oauth,
        ),
      ).toMatchObject({ reasoning_effort: "high" });
    },
  );
  it.each([false, true])(
    "Haiku API/OAuth toggle uses manual thinking with the SDK minimum (%s)",
    async (oauth) => {
      expect(
        await capturedRequest(
          "claude-haiku-4-5",
          driver("claudeAgent"),
          [{ id: "thinking", value: true }],
          oauth,
        ),
      ).toMatchObject({ thinking: { type: "enabled", budget_tokens: 1024 } });
    },
  );
  it.each([false, true])(
    "Opus 4.5 API/OAuth sends effort without adaptive thinking (%s)",
    async (oauth) => {
      const body = await capturedRequest(
        "claude-opus-4-5",
        driver("claudeAgent"),
        [{ id: "effort", value: "low" }],
        oauth,
      );

      expect(body).toMatchObject({ output_config: { effort: "low" } });
      expect(body).not.toHaveProperty("thinking");
    },
  );
  it("Custom API sends the saved effort under its own provider options", async () => {
    let body: unknown;

    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      body = JSON.parse(String(init?.body));
      throw stopped;
    });

    try {
      const modelOptions = nativeModelOptions(
        driver("customOpenai"),
        selection("local-model", [{ id: "reasoningEffort", value: "high" }]),
      );

      expect(modelOptions?.namespace).toBe("custom-openai");

      const model = resolveAkeruMastraModel(
        "custom-openai/local-model",
        auth,
        undefined,
        undefined,
        modelOptions,
        undefined,
        {
          environment: {},
          instanceEnvironment: { CUSTOM_OPENAI_BASE_URL: "http://127.0.0.1:9/v1" },
          useSavedCredential: false,
        },
      );

      if (
        !Predicate.isObject(model) ||
        !("specificationVersion" in model) ||
        model.specificationVersion !== "v3"
      )
        throw new Error("Expected a native language model");

      await expect(
        model.doGenerate({
          prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          ...withAkeruModelRunOptions({}, modelOptions ? { modelOptions } : {}),
        }),
      ).rejects.toThrow(stopped);
      expect(fetch).toHaveBeenCalledOnce();
      expect(body).toMatchObject({ reasoning_effort: "high" });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("Kimi sends adaptive effort without inventing a budget", async () => {
    const body = await capturedRequest("kimi-for-coding", driver("kimi"), [
      { id: "effort", value: "max" },
    ]);

    expect(body).toMatchObject({
      output_config: { effort: "max" },
      thinking: { type: "adaptive" },
    });
    expect(body).not.toHaveProperty("thinking.budget_tokens");
  });
  it.each([
    [
      "muse-spark-1.3-contributor",
      "reasoningEffort",
      "minimal",
      { reasoning: { effort: "minimal" } },
    ],
    ["qwen3.8-max", "effort", "xhigh", { output_config: { effort: "xhigh" } }],
    ["deepseek-v4-pro", "reasoningEffort", "max", { reasoning_effort: "max" }],
  ] as const)("Go %s serializes its protocol's field", async (model, id, value, expected) => {
    expect(await capturedRequest(model, driver("opencodeGo"), [{ id, value }])).toMatchObject(
      expected,
    );
  });
});

describe("reasoning capability and state boundaries", () => {
  it("retains only catalog levels and gives fixed models no invented levels", () => {
    const entry = { id: "model", name: "Model", efforts: ["minimal", "high"] };
    expect(
      reasoningCapabilities(driver("opencodeGo"), "muse-spark-1.3-contributor", entry)
        .optionDescriptors?.[0],
    ).toMatchObject({ options: [{ id: "default" }, { id: "minimal" }, { id: "high" }] });
    expect(
      reasoningCapabilities(driver("kimi"), "kimi-for-coding-highspeed", undefined)
        .optionDescriptors,
    ).toEqual([]);
  });
  it("separates native Claude effort from workflow choices", () => {
    const caps = claudeHarnessCapabilities("claude-opus-5-5", {
      id: "claude-opus-5-5",
      name: "Opus",
      efforts: ["low", "medium", "high", "xhigh", "max"],
    });

    expect(caps.optionDescriptors?.find((option) => option.id === "effort")).toMatchObject({
      options: [
        { id: "default" },
        { id: "low" },
        { id: "medium" },
        { id: "high" },
        { id: "xhigh" },
        { id: "max" },
      ],
    });
    expect(caps.optionDescriptors?.find((option) => option.id === "workflow")).toBeUndefined();
    expect(caps.optionDescriptors?.find((option) => option.id === "thinking")).toBeUndefined();
    expect(claudeHarnessCapabilities("claude-haiku-4-5", undefined).optionDescriptors).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "thinking" })]),
    );
  });

  it("retains known historical Claude effort when the refreshed catalog omits the model", () => {
    const caps = claudeHarnessCapabilities("claude-opus-4-5", undefined);

    expect(caps.optionDescriptors?.find((option) => option.id === "effort")).toMatchObject({
      options: [{ id: "default" }, { id: "low" }, { id: "medium" }, { id: "high" }],
    });
    expect(
      invalidReasoningSelection(
        selection("claude-opus-4-5", [{ id: "effort", value: "low" }]),
        caps,
      ),
    ).toBeUndefined();
    expect(claudeHarnessCapabilities("unknown-model", undefined).optionDescriptors).toEqual([]);
    expect(
      claudeHarnessCapabilities("claude-opus-4-5", {
        id: "claude-opus-4-5",
        name: "Opus",
      }).optionDescriptors?.find((option) => option.id === "effort"),
    ).toBeUndefined();
  });
  it("keeps the legacy Codex Fast toggle as the fast service tier", () => {
    expect(
      nativeModelOptions(driver("codex"), selection("gpt-5", [{ id: "fastMode", value: true }])),
    ).toEqual({ serviceTier: "fast" });
    expect(
      nativeModelOptions(
        driver("codex"),
        selection("gpt-5", [
          { id: "serviceTier", value: "priority" },
          { id: "fastMode", value: true },
        ]),
      ),
    ).toEqual({ serviceTier: "priority" });
  });

  it("runs saved Claude workflow efforts at provider default instead of rejecting them", () => {
    const caps = claudeHarnessCapabilities("claude-opus-5-5", undefined);

    for (const value of ["ultrathink", "ultracode"]) {
      const saved = selection("claude-opus-5-5", [{ id: "effort", value }]);

      expect(invalidReasoningSelection(saved, caps)).toBeUndefined();
      expect(nativeModelOptions(driver("claudeAgent"), saved)?.effort).toBeUndefined();
    }
  });
  it("decodes stored native fields including explicit false, and old Codex fields", () => {
    const context = new RequestContext();

    for (const modelOptions of [
      { namespace: "anthropic", effort: "max", thinking: false },
      { reasoningEffort: "high", serviceTier: "priority" },
    ] as const) {
      context.setRaw("controller", { state: { modelOptions } });
      expect(controllerModelOptions(context)).toEqual(modelOptions);
    }
  });
  it("validates known reasoning descriptors without rejecting unrelated or unsettled selections", () => {
    const caps = reasoningCapabilities(driver("kimi"), "kimi-for-coding", {
      id: "kimi-for-coding",
      name: "Kimi",
      efforts: ["low", "max"],
    });

    expect(
      invalidReasoningSelection(
        selection("kimi-for-coding", [{ id: "effort", value: "medium" }]),
        caps,
      ),
    ).toContain("does not support");
    expect(
      invalidReasoningSelection(
        selection("kimi-for-coding", [{ id: "custom", value: "future" }]),
        caps,
      ),
    ).toBeUndefined();
    expect(
      invalidReasoningSelection(
        selection("kimi-for-coding", [{ id: "effort", value: "medium" }]),
        null,
      ),
    ).toBeUndefined();
    const fixed = reasoningCapabilities(driver("kimi"), "fixed", undefined);
    expect(
      invalidReasoningSelection(selection("fixed", [{ id: "effort", value: "low" }]), fixed),
    ).toContain("not supported");
    expect(
      invalidReasoningSelection(selection("fixed", [{ id: "effort", value: "default" }]), fixed),
    ).toBeUndefined();

    const codexCaps = reasoningCapabilities(driver("codex"), "gpt-5", {
      id: "gpt-5",
      name: "GPT 5",
      efforts: ["minimal", "low", "medium", "high"],
    });

    expect(
      invalidReasoningSelection(
        selection("gpt-5", [{ id: "reasoningEffort", value: "off" }]),
        codexCaps,
      ),
    ).toContain("does not support");
    expect(
      invalidReasoningSelection(selection("gpt-5", [{ id: "reasoningEffort", value: "off" }]), {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [{ id: "off", label: "Off" }],
          },
        ],
      }),
    ).toBeUndefined();
    expect(nativeModelOptions(driver("kimi"), selection("kimi-for-coding"))).toBeUndefined();
    expect(
      withAkeruModelRunOptions({}, { modelOptions: { effort: "high", thinking: false } }),
    ).toEqual({
      providerOptions: { anthropic: { effort: "high", thinking: { type: "disabled" } } },
    });
    expect(withAkeruModelRunOptions({}, { modelOptions: { reasoningEffort: "default" } })).toEqual({
      providerOptions: { openai: {} },
    });
  });
});
