import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_DESKTOP_ONBOARDING_DRAFT,
  parseDesktopOnboardingDraft,
} from "./desktopOnboardingDraft";
import {
  desktopOnboardingModelSelection,
  resolveDesktopOnboardingCreationReadiness,
  resolveDesktopOnboardingEngine,
} from "./desktopOnboardingEngine";

describe("desktop onboarding engine", () => {
  it("uses the selected subscription provider and its default model", () => {
    const providers = [
      {
        instanceId: "codex",
        driver: "codex",
        enabled: true,
        installed: true,
        availability: "available" as const,
        models: [{ slug: "gpt-default", isDefault: true }],
      },
      {
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        enabled: true,
        installed: true,
        availability: "available" as const,
        models: [{ slug: "claude-old" }, { slug: "claude-default", isDefault: true }],
      },
      {
        instanceId: "opencodeGo",
        driver: "opencodeGo",
        enabled: true,
        installed: true,
        availability: "available" as const,
        models: [{ slug: "gpt-5.6-luna", isDefault: true }],
      },
    ];

    expect(resolveDesktopOnboardingEngine("anthropic", providers)).toEqual({
      provider: "claudeAgent",
      model: "claude-default",
    });
    expect(resolveDesktopOnboardingEngine("opencode-go", providers)).toEqual({
      provider: "opencodeGo",
      model: "gpt-5.6-luna",
    });
    expect(resolveDesktopOnboardingEngine("xai", providers)).toBeNull();
    expect(
      desktopOnboardingModelSelection({ provider: "claudeAgent", model: "claude-default" }),
    ).toEqual({ instanceId: "claudeAgent", model: "claude-default" });
  });

  it("keeps bot creation pending while the provider catalog is still loading", () => {
    expect(resolveDesktopOnboardingCreationReadiness("openai-codex", null)).toEqual({
      status: "loading",
    });
  });

  it("separates an unavailable provider from a provider catalog that is still loading", () => {
    expect(resolveDesktopOnboardingCreationReadiness("openai-codex", [])).toEqual({
      status: "unavailable",
    });
    expect(
      resolveDesktopOnboardingCreationReadiness("openai-codex", [
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          models: [{ slug: "gpt-default", isDefault: true }],
        },
      ]),
    ).toEqual({
      status: "ready",
      engine: { provider: "codex", model: "gpt-default" },
    });
  });

  it.each([
    ["openai-codex", "codex"],
    ["anthropic", "claudeAgent"],
    ["xai", "grok"],
    ["kimi-for-coding", "kimi"],
    ["opencode-go", "opencodeGo"],
  ] as const)("restores and resolves the %s subscription", (providerId, driver) => {
    const draft = { ...DEFAULT_DESKTOP_ONBOARDING_DRAFT, providerId };
    const provider = {
      instanceId: `${driver}-custom`,
      driver,
      enabled: true,
      installed: true,
      models: [{ slug: "first" }, { slug: "default", isDefault: true }],
    };

    expect(parseDesktopOnboardingDraft(JSON.stringify(draft))).toEqual(draft);
    expect(resolveDesktopOnboardingEngine(providerId, [provider])).toEqual({
      provider: provider.instanceId,
      model: "default",
    });
    expect(
      resolveDesktopOnboardingEngine(providerId, [{ ...provider, enabled: false }]),
    ).toBeNull();
    expect(
      resolveDesktopOnboardingEngine(providerId, [{ ...provider, installed: false }]),
    ).toBeNull();
    expect(
      resolveDesktopOnboardingEngine(providerId, [{ ...provider, availability: "unavailable" }]),
    ).toBeNull();
    expect(resolveDesktopOnboardingEngine(providerId, [{ ...provider, models: [] }])).toBeNull();
  });
});
