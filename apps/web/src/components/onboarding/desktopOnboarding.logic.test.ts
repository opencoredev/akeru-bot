import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_DESKTOP_ONBOARDING_DRAFT,
  DESKTOP_ONBOARDING_GOAL_MAX_LENGTH,
  DESKTOP_ONBOARDING_STEPS,
  DESKTOP_ONBOARDING_LEGACY_HANDOFF_STORAGE_KEY,
  desktopOnboardingProgress,
  markDesktopOnboardingCompleted,
  markDesktopOnboardingHandoffStarted,
  clearDesktopOnboardingHandoff,
  readDesktopOnboardingHandoff,
  readDesktopOnboardingHandoffForEnvironment,
  parseDesktopOnboardingDraft,
  recoverDisappearedDesktopOnboardingBot,
  recoverMissingDesktopOnboardingBot,
  resolveDesktopOnboardingFocusLabel,
  shouldShowDesktopOnboarding,
  stepNumber,
} from "./desktopOnboarding.logic";

/** A draft as the category picker saved it: no goal field, a category id instead. */
function legacyDraft() {
  const { goal: _goal, ...rest } = DEFAULT_DESKTOP_ONBOARDING_DRAFT;

  return { ...rest, step: "use-case" as const, customUseCase: "" };
}

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

  it("keeps a draft saved before the goal question, category and all", () => {
    const legacy = {
      step: "use-case",
      providerId: "anthropic",
      useCaseId: "inbox",
      customUseCase: "",
      name: "Nova",
      avatar: DEFAULT_DESKTOP_ONBOARDING_DRAFT.avatar,
      botId: null,
    };

    expect(parseDesktopOnboardingDraft(JSON.stringify(legacy))).toEqual({
      step: "goal",
      providerId: "anthropic",
      goal: "Triaging my inbox and drafting replies I approve",
      goalPhase: "ask",
      name: "Nova",
      avatar: DEFAULT_DESKTOP_ONBOARDING_DRAFT.avatar,
      botId: null,
    });
  });

  it("recovers the goal from the first generation of the picker", () => {
    const legacy = { ...legacyDraft(), useCaseId: "automate" };

    expect(parseDesktopOnboardingDraft(JSON.stringify(legacy))?.goal).toBe(
      "Automating a task I repeat",
    );
  });

  it("keeps the words typed against the old custom option", () => {
    const legacy = {
      ...legacyDraft(),
      useCaseId: "custom",
      customUseCase: "Track properties that match my buying criteria",
    };

    expect(parseDesktopOnboardingDraft(JSON.stringify(legacy))?.goal).toBe(
      "Track properties that match my buying criteria",
    );
  });

  it("prefers the chosen category over text left behind by an abandoned choice", () => {
    const legacy = {
      ...legacyDraft(),
      useCaseId: "research",
      customUseCase: "an abandoned answer",
    };

    expect(parseDesktopOnboardingDraft(JSON.stringify(legacy))?.goal).toBe(
      "Looking up the same facts and keeping one list current",
    );
  });

  it("keeps the rest of a draft whose category no longer exists", () => {
    const legacy = { ...legacyDraft(), name: "Nova", useCaseId: "retired" };

    expect(parseDesktopOnboardingDraft(JSON.stringify(legacy))).toEqual({
      ...DEFAULT_DESKTOP_ONBOARDING_DRAFT,
      step: "goal",
      name: "Nova",
      goal: "",
    });
  });

  it("round trips a goal and drops the fields the picker used to save", () => {
    const draft = {
      ...DEFAULT_DESKTOP_ONBOARDING_DRAFT,
      step: "goal" as const,
      goal: "Watch our suppliers' prices and tell me when one moves",
    };

    expect(parseDesktopOnboardingDraft(JSON.stringify({ ...draft, useCaseId: "inbox" }))).toEqual(
      draft,
    );
    expect(
      parseDesktopOnboardingDraft(
        JSON.stringify({ ...draft, goal: "a".repeat(DESKTOP_ONBOARDING_GOAL_MAX_LENGTH + 1) }),
      ),
    ).toBeNull();
  });

  it("preserves labeled instructions in new goals and question state after reload", () => {
    const draft = {
      ...DEFAULT_DESKTOP_ONBOARDING_DRAFT,
      step: "goal" as const,
      goal: "Build a dashboard\nProject: Client portal",
    };

    expect(parseDesktopOnboardingDraft(JSON.stringify(draft))).toEqual(draft);
    expect(parseDesktopOnboardingDraft(JSON.stringify({ ...draft, goalPhase: "plan" }))).toEqual({
      ...draft,
      goalPhase: "plan",
    });
  });

  it("strips obsolete follow-up answers only from identified legacy drafts", () => {
    const legacy = {
      ...legacyDraft(),
      goal: "Write my posts\nChannels: LinkedIn and X\nCadence: Three a week",
    };

    expect(parseDesktopOnboardingDraft(JSON.stringify(legacy))?.goal).toBe("Write my posts");
  });

  it("maps each state to its visible step", () => {
    expect(stepNumber("subscription")).toBe(1);
    expect(stepNumber("goal")).toBe(2);
    expect(stepNumber("identity")).toBe(3);
    expect(stepNumber("message")).toBe(4);
  });

  it("restores an OpenCode Go onboarding draft", () => {
    const draft = { ...DEFAULT_DESKTOP_ONBOARDING_DRAFT, providerId: "opencode-go" as const };

    expect(parseDesktopOnboardingDraft(JSON.stringify(draft))).toEqual(draft);
  });

  it("labels the live preview focus once the goal is worth showing", () => {
    expect(resolveDesktopOnboardingFocusLabel("   ")).toBeNull();
    expect(resolveDesktopOnboardingFocusLabel("  Track permits  ")).toBe("Track permits");
    // A goal typed across several lines still has to read on one chip line.
    expect(resolveDesktopOnboardingFocusLabel("Track permits\n\nand renewals")).toBe(
      "Track permits and renewals",
    );

    const truncated = resolveDesktopOnboardingFocusLabel("a".repeat(80));
    expect(truncated).toHaveLength(48);
    expect(truncated?.endsWith("…")).toBe(true);
  });

  it("reports progress from the step definitions", () => {
    expect(DESKTOP_ONBOARDING_STEPS.map((step) => step.id)).toEqual([
      "subscription",
      "goal",
      "identity",
      "message",
    ]);
    expect(desktopOnboardingProgress("subscription")).toEqual({
      number: 1,
      total: 4,
      fraction: 0,
      label: "Step 1 of 4",
    });
    expect(desktopOnboardingProgress("message")).toEqual({
      number: 4,
      total: 4,
      fraction: 1,
      label: "Step 4 of 4",
    });

    for (const step of DESKTOP_ONBOARDING_STEPS) {
      expect(desktopOnboardingProgress(step.id).number).toBe(stepNumber(step.id));
    }
  });
});
