import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_DESKTOP_ONBOARDING_DRAFT,
  DESKTOP_ONBOARDING_STEPS,
  DESKTOP_ONBOARDING_LEGACY_HANDOFF_STORAGE_KEY,
  desktopOnboardingProgress,
  markDesktopOnboardingCompleted,
  markDesktopOnboardingHandoffStarted,
  clearDesktopOnboardingHandoff,
  readDesktopOnboardingHandoff,
  readDesktopOnboardingHandoffForEnvironment,
  parseDesktopOnboardingDraft,
  recoverMissingDesktopOnboardingBot,
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
        draft: { ...DEFAULT_DESKTOP_ONBOARDING_DRAFT, botId: "bot-1" },
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
        draft: { ...DEFAULT_DESKTOP_ONBOARDING_DRAFT, botId: "bot-1" },
        completed: false,
        started: true,
      }),
    ).toBe(false);
  });

  it("stays open after creating the first bot until the overlay finishes", () => {
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

  it("clears a missing created bot so Connect can retry", () => {
    const draft = {
      ...DEFAULT_DESKTOP_ONBOARDING_DRAFT,
      botId: "bot-missing",
    };

    expect(recoverMissingDesktopOnboardingBot(draft, ["bot-other"])).toEqual({
      ...draft,
      botId: null,
    });
    expect(recoverMissingDesktopOnboardingBot(draft, ["bot-missing"])).toBe(draft);
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

  it("records the handoff destination with completion and routes to it once", () => {
    const values = new Map<string, string>([["akeru:desktop-onboarding:v1", "draft"]]);

    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    };

    markDesktopOnboardingHandoffStarted(storage, "environment-1", "bot-ada");

    expect(values.get("akeru:desktop-onboarding:v1")).toBeUndefined();
    expect(values.get("akeru:desktop-onboarding-completed:v1")).toBe("1");
    expect(readDesktopOnboardingHandoff(storage)).toEqual({
      environmentId: "environment-1",
      botId: "bot-ada",
    });
    expect(readDesktopOnboardingHandoff(storage)).toEqual({
      environmentId: "environment-1",
      botId: "bot-ada",
    });
    clearDesktopOnboardingHandoff(storage);
    expect(readDesktopOnboardingHandoff(storage)).toBeNull();
  });

  it("migrates a v1 handoff only after the active environment confirms its bot", () => {
    const values = new Map<string, string>([
      [DESKTOP_ONBOARDING_LEGACY_HANDOFF_STORAGE_KEY, "bot-ada"],
    ]);

    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    };

    expect(readDesktopOnboardingHandoffForEnvironment(storage, "other-environment", [])).toBeNull();
    expect(values.get(DESKTOP_ONBOARDING_LEGACY_HANDOFF_STORAGE_KEY)).toBe("bot-ada");
    expect(
      readDesktopOnboardingHandoffForEnvironment(storage, "environment-1", ["bot-ada"]),
    ).toEqual({ environmentId: "environment-1", botId: "bot-ada" });
    expect(values.has(DESKTOP_ONBOARDING_LEGACY_HANDOFF_STORAGE_KEY)).toBe(false);
    expect(readDesktopOnboardingHandoff(storage)).toEqual({
      environmentId: "environment-1",
      botId: "bot-ada",
    });
    clearDesktopOnboardingHandoff(storage);
    expect(readDesktopOnboardingHandoff(storage)).toBeNull();
  });

  it("drops an empty legacy handoff instead of migrating it", () => {
    const values = new Map<string, string>([
      [DESKTOP_ONBOARDING_LEGACY_HANDOFF_STORAGE_KEY, "   "],
    ]);

    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    };

    expect(
      readDesktopOnboardingHandoffForEnvironment(storage, "environment-1", ["bot-ada"]),
    ).toBeNull();
    expect(values.has(DESKTOP_ONBOARDING_LEGACY_HANDOFF_STORAGE_KEY)).toBe(false);
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

    const customColorDraft = {
      ...DEFAULT_DESKTOP_ONBOARDING_DRAFT,
      avatar: { ...DEFAULT_DESKTOP_ONBOARDING_DRAFT.avatar, color: "#123ABC" },
    };

    expect(parseDesktopOnboardingDraft(JSON.stringify(customColorDraft))).toEqual(customColorDraft);
    expect(
      parseDesktopOnboardingDraft(
        JSON.stringify({
          ...DEFAULT_DESKTOP_ONBOARDING_DRAFT,
          avatar: { ...DEFAULT_DESKTOP_ONBOARDING_DRAFT.avatar, color: "not-a-color" },
        }),
      ),
    ).toBeNull();
    expect(parseDesktopOnboardingDraft("not json")).toBeNull();
    expect(
      parseDesktopOnboardingDraft(
        JSON.stringify({ ...DEFAULT_DESKTOP_ONBOARDING_DRAFT, providerId: "unknown" }),
      ),
    ).toBeNull();
  });

  it("coerces a four-step draft back onto Connect and keeps the provider", () => {
    const legacy = {
      step: "identity",
      providerId: "anthropic",
      goal: "Triaging my inbox",
      goalPhase: "plan",
      name: "Nova",
      avatar: DEFAULT_DESKTOP_ONBOARDING_DRAFT.avatar,
      botId: null,
    };

    expect(parseDesktopOnboardingDraft(JSON.stringify(legacy))).toEqual({
      step: "subscription",
      providerId: "anthropic",
      name: "Nova",
      avatar: DEFAULT_DESKTOP_ONBOARDING_DRAFT.avatar,
      botId: null,
    });
  });

  it("maps each state to its visible step", () => {
    expect(stepNumber("subscription")).toBe(1);
  });

  it("restores an OpenCode Go onboarding draft", () => {
    const draft = { ...DEFAULT_DESKTOP_ONBOARDING_DRAFT, providerId: "opencode-go" as const };

    expect(parseDesktopOnboardingDraft(JSON.stringify(draft))).toEqual(draft);
  });

  it("reports progress from the step definitions", () => {
    expect(DESKTOP_ONBOARDING_STEPS.map((step) => step.id)).toEqual(["subscription"]);
    expect(desktopOnboardingProgress("subscription")).toEqual({
      number: 1,
      total: 1,
      fraction: 1,
      label: "Step 1 of 1",
    });
  });
});
