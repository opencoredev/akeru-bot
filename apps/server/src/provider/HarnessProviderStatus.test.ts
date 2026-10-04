import { describe, expect, it } from "vite-plus/test";

import { codexModelCapabilities, harnessModelName } from "./HarnessProviderStatus.ts";
import {
  getClaudeModelCapabilities,
  normalizeClaudeCliEffort,
} from "./Layers/claude/ClaudeModels.ts";

describe("harnessModelName", () => {
  it("formats model slugs as picker names", () => {
    expect(
      [
        "gpt-6.1-sol",
        "gpt-6-luna",
        "gpt-5.3-codex-spark",
        "gpt-5",
        "gpt-daybreak-blue-latest",
        "claude-opus-5-5",
        "claude-sonnet-5",
        "grok-4.20-beta",
      ].map(harnessModelName),
    ).toEqual([
      "GPT-6.1 Sol",
      "GPT-6 Luna",
      "GPT-5.3 Codex Spark",
      "GPT-5",
      "GPT Daybreak Blue Latest",
      "Claude Opus 5.5",
      "Claude Sonnet 5",
      "Grok 4.20 Beta",
    ]);
  });
});

describe("codexModelCapabilities", () => {
  const options = (slug: string, entry: Parameters<typeof codexModelCapabilities>[1]) =>
    codexModelCapabilities(slug, entry).optionDescriptors?.map((descriptor) => [
      descriptor.id,
      descriptor.type === "select" ? descriptor.options.map((option) => option.id) : [],
    ]);

  it("offers the catalog's efforts and Fast only when models.dev lists it", () => {
    expect(
      options("gpt-next", {
        id: "gpt-next",
        name: "GPT Next",
        efforts: ["default", "none", "low", "medium", "xhigh"],
        fast: true,
      }),
    ).toEqual([
      ["reasoningEffort", ["default", "none", "low", "medium", "xhigh"]],
      ["serviceTier", ["default", "priority"]],
    ]);
    expect(options("gpt-slow", { id: "gpt-slow", name: "GPT Slow", efforts: ["high"] })).toEqual([
      ["reasoningEffort", ["default", "high"]],
    ]);
  });

  it("retains catalog levels without the SDK thinking-level coercion", () => {
    const efforts = ["low", "medium", "high", "xhigh", "max"];

    expect(options("gpt-daybreak-blue-latest", { id: "x", name: "X", efforts })).toEqual([
      ["reasoningEffort", ["default", ...efforts]],
    ]);
    expect(options("gpt-6.1-sol", { id: "x", name: "X", efforts })).toEqual([
      ["reasoningEffort", ["default", ...efforts]],
    ]);
  });
});

describe("getClaudeModelCapabilities", () => {
  it("gives a model newer than this build its family's capabilities", () => {
    expect(getClaudeModelCapabilities("claude-sonnet-5-5")).toBe(
      getClaudeModelCapabilities("claude-sonnet-5"),
    );
    expect(getClaudeModelCapabilities("claude-opus-9")).toBe(
      getClaudeModelCapabilities("claude-opus-5-5"),
    );
    expect(getClaudeModelCapabilities("claude-unknown").optionDescriptors).toEqual(
      getClaudeModelCapabilities("not-a-model").optionDescriptors,
    );
  });

  it("keeps Extra High for a newer model whose family supports it", () => {
    expect(normalizeClaudeCliEffort("xhigh", "claude-sonnet-5-5")).toBe("xhigh");
    expect(normalizeClaudeCliEffort("xhigh", "claude-opus-9")).toBe("xhigh");
    expect(normalizeClaudeCliEffort("xhigh", "claude-sonnet-4-6")).toBe("max");
  });
});
