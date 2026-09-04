import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_DESKTOP_ONBOARDING_DRAFT,
  desktopOnboardingModelSelection,
  markDesktopOnboardingCompleted,
  parseDesktopOnboardingDraft,
  recoverDisappearedDesktopOnboardingBot,
  recoverMissingDesktopOnboardingBot,
  resolveDesktopOnboardingEngine,
  resolveDesktopOnboardingUseCase,
  shouldShowDesktopOnboarding,
  stepNumber,
} from "./desktopOnboarding.logic";

describe("desktop onboarding", () => {
  it("starts only on desktop after an empty roster loads", () => {
    expect(
      shouldShowDesktopOnboarding({
        desktop: true,
        rosterLoaded: true,
        serverBotCount: 0,
        draft: null,
        completed: false,
        started: false,
      }),
    ).toBe(true);
    expect(
      shouldShowDesktopOnboarding({
        desktop: false,
        rosterLoaded: true,
        serverBotCount: 0,
        draft: null,
        completed: false,
        started: false,
      }),
    ).toBe(false);
    expect(
      shouldShowDesktopOnboarding({
        desktop: true,
        rosterLoaded: false,
        serverBotCount: 0,
        draft: null,
        completed: false,
        started: false,
      }),
    ).toBe(false);
    expect(
      shouldShowDesktopOnboarding({
        desktop: true,
        rosterLoaded: true,
        serverBotCount: 1,
        draft: null,
        completed: false,
        started: false,
      }),
    ).toBe(false);
  });

  it("resumes an unfinished flow after the bot exists", () => {
    expect(
      shouldShowDesktopOnboarding({
        desktop: true,
        rosterLoaded: true,
        serverBotCount: 1,
        draft: { ...DEFAULT_DESKTOP_ONBOARDING_DRAFT, step: "message", botId: "bot-1" },
        completed: false,
        started: false,
      }),
    ).toBe(true);
  });

  it("waits for roster synchronization before resuming a saved draft", () => {
    expect(
      shouldShowDesktopOnboarding({
        desktop: true,
        rosterLoaded: false,
        serverBotCount: 0,
        draft: { ...DEFAULT_DESKTOP_ONBOARDING_DRAFT, step: "message", botId: "bot-1" },
        completed: false,
        started: true,
      }),
    ).toBe(false);
  });

  it("stays open after creating the first bot", () => {
    expect(
      shouldShowDesktopOnboarding({
        desktop: true,
        rosterLoaded: true,
        serverBotCount: 1,
        draft: null,
        completed: false,
        started: true,
      }),
    ).toBe(true);
  });

  it("returns a resumed message step to identity when its bot no longer exists", () => {
    const draft = {
      ...DEFAULT_DESKTOP_ONBOARDING_DRAFT,
      step: "message" as const,
      botId: "bot-missing",
    };

    expect(recoverMissingDesktopOnboardingBot(draft, ["bot-other"])).toEqual({
      ...draft,
      step: "identity",
      botId: null,
    });
    expect(recoverMissingDesktopOnboardingBot(draft, ["bot-missing"])).toBe(draft);
  });

  it("returns a mounted message step to identity only after its bot was ready", () => {
    const draft = {
      ...DEFAULT_DESKTOP_ONBOARDING_DRAFT,
      step: "message" as const,
      botId: "bot-1",
    };

    expect(recoverDisappearedDesktopOnboardingBot(draft, null)).toBe(draft);
    expect(recoverDisappearedDesktopOnboardingBot(draft, "bot-other")).toBe(draft);
    expect(recoverDisappearedDesktopOnboardingBot(draft, "bot-1")).toEqual({
      ...draft,
      step: "identity",
      botId: null,
    });
  });

  it("marks skipped onboarding complete and removes its draft", () => {
    const values = new Map<string, string>([["akeru:desktop-onboarding:v1", "draft"]]);
    const storage = {
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    };

    markDesktopOnboardingCompleted(storage);

    expect(values.get("akeru:desktop-onboarding:v1")).toBeUndefined();
    expect(values.get("akeru:desktop-onboarding-completed:v1")).toBe("1");
  });

  it("does not restart after the completed user deletes every bot", () => {
    expect(
      shouldShowDesktopOnboarding({
        desktop: true,
        rosterLoaded: true,
        serverBotCount: 0,
        draft: null,
        completed: true,
        started: false,
      }),
    ).toBe(false);
  });

  it("round trips a valid draft and rejects invalid stored data", () => {
    expect(parseDesktopOnboardingDraft(JSON.stringify(DEFAULT_DESKTOP_ONBOARDING_DRAFT))).toEqual(
      DEFAULT_DESKTOP_ONBOARDING_DRAFT,
    );
    expect(parseDesktopOnboardingDraft("not json")).toBeNull();
    expect(
      parseDesktopOnboardingDraft(
        JSON.stringify({ ...DEFAULT_DESKTOP_ONBOARDING_DRAFT, providerId: "unknown" }),
      ),
    ).toBeNull();
  });

  it("resumes an older draft without a custom use case", () => {
    const { customUseCase: _, ...olderDraft } = DEFAULT_DESKTOP_ONBOARDING_DRAFT;

    expect(parseDesktopOnboardingDraft(JSON.stringify(olderDraft))).toEqual({
      ...olderDraft,
      customUseCase: "",
    });
  });

  it("accepts a custom use case and creates its starter message", () => {
    const draft = {
      ...DEFAULT_DESKTOP_ONBOARDING_DRAFT,
      useCaseId: "custom" as const,
      customUseCase: "Track properties that match my buying criteria",
    };

    expect(parseDesktopOnboardingDraft(JSON.stringify(draft))).toEqual(draft);
    expect(resolveDesktopOnboardingUseCase(draft.useCaseId, draft.customUseCase)).toEqual({
      description: "Track properties that match my buying criteria",
      prompt:
        "Help me with this: Track properties that match my buying criteria\n\nBefore we automate it, help me define the inputs, rules, approval points, and finished result.",
    });
  });

  it("maps each state to its visible step", () => {
    expect(stepNumber("subscription")).toBe(1);
    expect(stepNumber("use-case")).toBe(2);
    expect(stepNumber("identity")).toBe(3);
    expect(stepNumber("message")).toBe(4);
  });

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

  it("restores an OpenCode Go onboarding draft", () => {
    const draft = { ...DEFAULT_DESKTOP_ONBOARDING_DRAFT, providerId: "opencode-go" as const };

    expect(parseDesktopOnboardingDraft(JSON.stringify(draft))).toEqual(draft);
  });
});
