import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ModelCapabilities } from "@akeru/contracts";

import {
  applyClaudePromptEffortPrefix,
  botEngineFromModelSelection,
  botEngineModelSelection,
  buildProviderOptionSelectionsFromDescriptors,
  createModelCapabilities,
  createModelSelection,
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
  getProviderOptionBooleanSelectionValue,
  getProviderOptionStringSelectionValue,
  normalizeCustomModelSlug,
  normalizeModelSlug,
  providerOptionsForModelChange,
  retainChosenProviderOptions,
} from "./model.ts";

const codexCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "xhigh", label: "Extra High" },
        { id: "high", label: "High", isDefault: true },
      ],
      currentValue: "high",
    },
    {
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
    },
  ],
});

const claudeCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "effort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "medium", label: "Medium" },
        { id: "high", label: "High", isDefault: true },
        { id: "ultrathink", label: "Ultrathink" },
      ],
      currentValue: "high",
      promptInjectedValues: ["ultrathink"],
    },
    {
      id: "contextWindow",
      label: "Context Window",
      type: "select",
      options: [
        { id: "200k", label: "200k" },
        { id: "1m", label: "1M", isDefault: true },
      ],
      currentValue: "1m",
    },
  ],
});

describe("descriptor helpers", () => {
  it("applies selection values to capability descriptors", () => {
    expect(
      getProviderOptionDescriptors({
        caps: claudeCaps,
        selections: [
          { id: "effort", value: "medium" },
          { id: "contextWindow", value: "200k" },
        ],
      }),
    ).toEqual([
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
          { id: "ultrathink", label: "Ultrathink" },
        ],
        currentValue: "medium",
        promptInjectedValues: ["ultrathink"],
      },
      {
        id: "contextWindow",
        label: "Context Window",
        type: "select",
        options: [
          { id: "200k", label: "200k" },
          { id: "1m", label: "1M", isDefault: true },
        ],
        currentValue: "200k",
      },
    ]);
  });

  it("builds wire-format option selections from descriptors", () => {
    const descriptors = getProviderOptionDescriptors({
      caps: codexCaps,
      selections: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });

    expect(buildProviderOptionSelectionsFromDescriptors(descriptors)).toEqual([
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);
  });

  it("stores option selection arrays in model selections", () => {
    expect(
      createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });
  });

  it("reads typed option selection values", () => {
    const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);

    expect(getProviderOptionStringSelectionValue(selection.options, "reasoningEffort")).toBe(
      "high",
    );
    expect(getProviderOptionStringSelectionValue(selection.options, "fastMode")).toBeUndefined();
    expect(getProviderOptionBooleanSelectionValue(selection.options, "fastMode")).toBe(true);
    expect(
      getProviderOptionBooleanSelectionValue(selection.options, "reasoningEffort"),
    ).toBeUndefined();
    expect(getModelSelectionStringOptionValue(selection, "reasoningEffort")).toBe("high");
    expect(getModelSelectionBooleanOptionValue(selection, "fastMode")).toBe(true);
  });
});

describe("model slug normalization", () => {
  it("preserves exact custom slugs instead of expanding provider aliases", () => {
    const claude = ProviderDriverKind.make("claudeAgent");

    expect(normalizeModelSlug("opus", claude)).toBe("claude-opus-5-5");
    expect(normalizeCustomModelSlug(" opus ")).toBe("opus");
  });
});

describe("applyClaudePromptEffortPrefix", () => {
  it("keeps slash commands intact when ultrathink is selected", () => {
    expect(applyClaudePromptEffortPrefix("/compact", "ultrathink")).toBe("/compact");
    expect(applyClaudePromptEffortPrefix(" /compact keep recent errors ", "ultrathink")).toBe(
      "/compact keep recent errors",
    );
    expect(applyClaudePromptEffortPrefix(" /review src/model.ts ", "ultrathink")).toBe(
      "/review src/model.ts",
    );
    expect(applyClaudePromptEffortPrefix("/security-review", "ultrathink")).toBe(
      "/security-review",
    );
    expect(applyClaudePromptEffortPrefix("/plugin:skill run", "ultrathink")).toBe(
      "/plugin:skill run",
    );
    expect(applyClaudePromptEffortPrefix("/deploy.prod to staging", "ultrathink")).toBe(
      "/deploy.prod to staging",
    );
  });

  it("still adds the ultrathink prefix to ordinary prompts", () => {
    expect(applyClaudePromptEffortPrefix("Investigate this failure", "ultrathink")).toBe(
      "Ultrathink:\nInvestigate this failure",
    );
    expect(applyClaudePromptEffortPrefix("/home/theo/app.ts crashed on load", "ultrathink")).toBe(
      "Ultrathink:\n/home/theo/app.ts crashed on load",
    );
  });
});

const nativeReasoningCaps = (levels: ReadonlyArray<string>): ModelCapabilities =>
  createModelCapabilities({
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: "default",
        options: [
          { id: "default", label: "Provider default", isDefault: true },
          ...levels.map((id) => ({ id, label: id })),
        ],
      },
    ],
  });

const haikuCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [{ id: "thinking", label: "Thinking", type: "boolean" }],
});

describe("bot engine option helpers", () => {
  it("shows and retains legacy off as none only when the model offers none", () => {
    const options = [{ id: "reasoningEffort", value: "off" }];
    const caps = nativeReasoningCaps(["none", "low"]);
    const descriptors = getProviderOptionDescriptors({ caps, selections: options });

    expect(descriptors[0]?.currentValue).toBe("none");
    expect(buildProviderOptionSelectionsFromDescriptors(descriptors)).toEqual([
      { id: "reasoningEffort", value: "none" },
    ]);
    expect(retainChosenProviderOptions(options, caps)).toEqual([
      { id: "reasoningEffort", value: "none" },
    ]);
    expect(
      providerOptionsForModelChange({
        previous: createModelSelection(ProviderInstanceId.make("codex"), "gpt-a", options),
        instanceId: "codex",
        nextCaps: caps,
      }),
    ).toEqual([{ id: "reasoningEffort", value: "none" }]);
    expect(retainChosenProviderOptions(options, nativeReasoningCaps(["low"]))).toBeUndefined();
    expect(retainChosenProviderOptions(options, nativeReasoningCaps(["off"]))).toEqual(options);
  });

  it("keeps only advertised, non-default choices", () => {
    expect(
      retainChosenProviderOptions(
        [
          { id: "reasoningEffort", value: "minimal" },
          { id: "serviceTier", value: "fast" },
        ],
        nativeReasoningCaps(["minimal", "high"]),
      ),
    ).toEqual([{ id: "reasoningEffort", value: "minimal" }]);
  });

  it("removes a choice reset to the provider default", () => {
    expect(
      retainChosenProviderOptions(
        [{ id: "reasoningEffort", value: "default" }],
        nativeReasoningCaps(["high"]),
      ),
    ).toBeUndefined();
  });

  it("keeps a real choice whose id is spelled default when it is not the default", () => {
    const caps = createModelCapabilities({
      optionDescriptors: [
        {
          id: "variant",
          label: "Variant",
          type: "select",
          options: [
            { id: "high", label: "High", isDefault: true },
            { id: "default", label: "Default" },
          ],
        },
      ],
    });

    expect(retainChosenProviderOptions([{ id: "variant", value: "default" }], caps)).toEqual([
      { id: "variant", value: "default" },
    ]);
    expect(retainChosenProviderOptions([{ id: "variant", value: "high" }], caps)).toBeUndefined();
  });

  it("drops prompt-injected workflow values and unsupported levels", () => {
    expect(
      retainChosenProviderOptions(
        [
          { id: "effort", value: "ultrathink" },
          { id: "contextWindow", value: "200k" },
        ],
        claudeCaps,
      ),
    ).toEqual([{ id: "contextWindow", value: "200k" }]);
    expect(
      retainChosenProviderOptions(
        [{ id: "reasoningEffort", value: "max" }],
        nativeReasoningCaps(["high"]),
      ),
    ).toBeUndefined();
  });

  it("preserves both values of a boolean without an advertised default", () => {
    expect(retainChosenProviderOptions([{ id: "thinking", value: false }], haikuCaps)).toEqual([
      { id: "thinking", value: false },
    ]);
    expect(retainChosenProviderOptions([{ id: "thinking", value: true }], haikuCaps)).toEqual([
      { id: "thinking", value: true },
    ]);
  });

  it("keeps options when capabilities are unknown but clears them for an authoritative empty list", () => {
    const options = [{ id: "reasoningEffort", value: "high" }];

    expect(retainChosenProviderOptions(options, null)).toEqual(options);
    expect(retainChosenProviderOptions(options, {})).toEqual(options);
    expect(
      retainChosenProviderOptions(options, createModelCapabilities({ optionDescriptors: [] })),
    ).toBeUndefined();
  });

  it("carries supported choices to another model on the same instance", () => {
    const previous = createModelSelection(ProviderInstanceId.make("codex"), "gpt-a", [
      { id: "reasoningEffort", value: "minimal" },
    ]);

    expect(
      providerOptionsForModelChange({
        previous,
        instanceId: "codex",
        nextCaps: nativeReasoningCaps(["minimal", "high"]),
      }),
    ).toEqual([{ id: "reasoningEffort", value: "minimal" }]);
    expect(
      providerOptionsForModelChange({
        previous,
        instanceId: "codex",
        nextCaps: nativeReasoningCaps(["high"]),
      }),
    ).toBeUndefined();
    expect(
      providerOptionsForModelChange({ previous, instanceId: "codex", nextCaps: null }),
    ).toBeUndefined();
  });

  it("clears choices when the model moves to another provider instance", () => {
    expect(
      providerOptionsForModelChange({
        previous: createModelSelection(ProviderInstanceId.make("codex"), "gpt-a", [
          { id: "reasoningEffort", value: "high" },
        ]),
        instanceId: "grok",
        nextCaps: nativeReasoningCaps(["high"]),
      }),
    ).toBeUndefined();
  });

  it("reads a saved engine without borrowing anything and saves only chosen options", () => {
    expect(botEngineModelSelection({ provider: "claudeAgent", model: "claude-opus-5-5" })).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
    });
    expect(
      botEngineFromModelSelection(
        createModelSelection(ProviderInstanceId.make("codex"), "gpt-a", [
          { id: "reasoningEffort", value: "default" },
        ]),
        nativeReasoningCaps(["high"]),
      ),
    ).toEqual({ provider: "codex", model: "gpt-a" });
  });

  it("keeps an explicit OpenCode variant that matches a common default", () => {
    const caps = {
      optionDescriptors: [
        {
          id: "variant",
          label: "Variant",
          type: "select" as const,
          currentValue: "default",
          options: [
            { id: "default", label: "Provider default", isDefault: true },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
          ],
        },
      ],
    };

    expect(
      botEngineFromModelSelection(
        createModelSelection(ProviderInstanceId.make("opencode"), "openai/gpt-5.4", [
          { id: "variant", value: "medium" },
        ]),
        caps,
      ),
    ).toEqual({
      provider: "opencode",
      model: "openai/gpt-5.4",
      options: [{ id: "variant", value: "medium" }],
    });
  });
});
