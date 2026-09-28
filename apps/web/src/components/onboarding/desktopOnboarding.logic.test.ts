import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_DESKTOP_ONBOARDING_DRAFT,
  DESKTOP_ONBOARDING_CELEBRATION_PIECES,
  DESKTOP_ONBOARDING_GOAL_MAX_LENGTH,
  DESKTOP_ONBOARDING_STEPS,
  DESKTOP_ONBOARDING_DESTINATION_TIMEOUT_MS,
  DESKTOP_ONBOARDING_HANDOFF_PHASES,
  DESKTOP_ONBOARDING_HANDOFF_STAGES,
  DESKTOP_ONBOARDING_REVEAL_DURATION_MS,
  canStartDesktopOnboardingReveal,
  desktopOnboardingCelebrationPieces,
  desktopOnboardingDestinationReady,
  desktopOnboardingHandoffAvatarState,
  desktopOnboardingHandoffDurationMs,
  desktopOnboardingHandoffStages,
  desktopOnboardingHandoffStatus,
  desktopOnboardingHandoffStatuses,
  desktopOnboardingModelSelection,
  desktopOnboardingProgress,
  markDesktopOnboardingCompleted,
  markDesktopOnboardingHandoffStarted,
  clearDesktopOnboardingHandoff,
  readDesktopOnboardingHandoff,
  parseDesktopOnboardingDraft,
  recoverDisappearedDesktopOnboardingBot,
  recoverMissingDesktopOnboardingBot,
  resolveDesktopOnboardingCreationReadiness,
  resolveDesktopOnboardingEngine,
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

    markDesktopOnboardingHandoffStarted(storage, "bot-ada");

    expect(values.get("akeru:desktop-onboarding:v1")).toBeUndefined();
    expect(values.get("akeru:desktop-onboarding-completed:v1")).toBe("1");
    expect(readDesktopOnboardingHandoff(storage)).toBe("bot-ada");
    expect(readDesktopOnboardingHandoff(storage)).toBe("bot-ada");
    clearDesktopOnboardingHandoff(storage);
    expect(readDesktopOnboardingHandoff(storage)).toBeNull();
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

  it("keeps the celebration burst stable across re-renders and tinted by the avatar", () => {
    const burst = desktopOnboardingCelebrationPieces("bot-1", "#8B6FC9");

    expect(burst).toHaveLength(DESKTOP_ONBOARDING_CELEBRATION_PIECES);
    // A re-render mid-flight must not re-roll the particles and restart them.
    expect(desktopOnboardingCelebrationPieces("bot-1", "#8B6FC9")).toEqual(burst);
    expect(desktopOnboardingCelebrationPieces("bot-2", "#8B6FC9")).not.toEqual(burst);
    expect(burst.some((piece) => piece.color === "#8B6FC9")).toBe(true);

    for (const piece of burst) {
      expect(piece.color).toMatch(/^#[\dA-F]{6}$/i);
      expect(piece.color).not.toBe("#FFFFFF");
      expect(piece.y).toBeLessThan(0);
      expect(piece.delay).toBeGreaterThanOrEqual(0);
      expect(piece.delay).toBeLessThanOrEqual(0.12);
      expect(piece.scale).toBeGreaterThan(0);
    }
  });

  it("falls back to the palette when the avatar color is unusable", () => {
    const burst = desktopOnboardingCelebrationPieces("bot-1", "not-a-color", 4);

    expect(burst).toHaveLength(4);
    for (const piece of burst) expect(piece.color).toMatch(/^#[\dA-F]{6}$/i);
    expect(desktopOnboardingCelebrationPieces("bot-1", "#8B6FC9", 0)).toEqual([]);
  });
  it("times only the beats that play while setup is still opaque", () => {
    const stages = desktopOnboardingHandoffStages(false);

    // The clock stops at `opening`. `revealing` and `done` are gated on the
    // destination, so putting them on a timer would be the bug this schedule
    // exists to avoid.
    expect(stages.map((stage) => stage.phase)).toEqual(["sending", "waking", "opening"]);
    expect(DESKTOP_ONBOARDING_HANDOFF_PHASES).toEqual([
      "sending",
      "waking",
      "opening",
      "revealing",
      "done",
    ]);
    expect(stages[0]?.atMs).toBe(0);
    for (const [index, stage] of stages.entries()) {
      if (index === 0) continue;
      // Each beat has to land after the one before it, or the workspace opens
      // before the user has been told anything.
      expect(stage.atMs).toBeGreaterThan(stages[index - 1]!.atMs);
    }
    // Long enough to read as beats, short enough never to gate the chat.
    const total = desktopOnboardingHandoffDurationMs(false);
    expect(total).toBeGreaterThanOrEqual(1_000);
    expect(total).toBeLessThanOrEqual(1_500);
  });

  it("gives the fade its own clock, started by readiness", () => {
    // The fade is not on the schedule at all: it begins when the destination
    // reports itself, and setup unmounts on its last frame.
    expect(desktopOnboardingHandoffStages(false).some((stage) => stage.phase === "revealing")).toBe(
      false,
    );
    // Slow enough to read as one surface leaving, quick enough not to wait on.
    expect(DESKTOP_ONBOARDING_REVEAL_DURATION_MS).toBeGreaterThanOrEqual(350);
    expect(DESKTOP_ONBOARDING_REVEAL_DURATION_MS).toBeLessThanOrEqual(450);
    // Failure safety has to outlast a slow-but-working handoff by a long way,
    // or the timeout becomes the normal path.
    expect(DESKTOP_ONBOARDING_DESTINATION_TIMEOUT_MS).toBeGreaterThan(
      desktopOnboardingHandoffDurationMs(false) * 3,
    );
  });

  it("collapses the handoff wait for reduced motion without dropping a beat", () => {
    const stages = desktopOnboardingHandoffStages(true);

    expect(stages.map((stage) => stage.phase)).toEqual(
      DESKTOP_ONBOARDING_HANDOFF_STAGES.map((stage) => stage.phase),
    );
    expect(stages.every((stage) => stage.atMs === 0)).toBe(true);
    expect(desktopOnboardingHandoffDurationMs(true)).toBe(0);
    // Collapsing the wait must not rewrite the shared schedule.
    expect(desktopOnboardingHandoffDurationMs(false)).toBeGreaterThan(0);
  });

  it("narrates the handoff with what actually happened", () => {
    expect(desktopOnboardingHandoffStatus("sending", "Wander")).toBe("Message sent");
    expect(desktopOnboardingHandoffStatus("waking", "Wander")).toBe("Waking Wander up");
    expect(desktopOnboardingHandoffStatus("opening", "Wander")).toBe("Opening your workspace");
    expect(desktopOnboardingHandoffStatus("revealing", "Wander")).toBe("Opening your workspace");
    expect(desktopOnboardingHandoffStatus("done", "Wander")).toBe("Opening your workspace");
    expect(desktopOnboardingHandoffStatus("waking", "  ")).toBe("Waking your bot up");
  });

  it("sizes the status box from every line it will show", () => {
    const statuses = desktopOnboardingHandoffStatuses("Wander");

    expect(statuses).toEqual(["Message sent", "Waking Wander up", "Opening your workspace"]);
    for (const phase of DESKTOP_ONBOARDING_HANDOFF_PHASES) {
      expect(statuses).toContain(desktopOnboardingHandoffStatus(phase, "Wander"));
    }
    expect(desktopOnboardingHandoffStatuses("Verylongbotnamehere")[1]).toBe(
      "Waking Verylongbotnamehere up",
    );
  });

  it("waits for the sent message and its turn before calling the destination ready", () => {
    const ready = {
      threadLinked: true,
      submittedMessage: "Help me plan the week",
      messages: [{ role: "user", text: "Help me plan the week" }],
      turnStarted: true,
    };

    expect(desktopOnboardingDestinationReady(ready)).toBe(true);
    // Each piece on its own is the empty chat this gate exists to prevent.
    expect(desktopOnboardingDestinationReady({ ...ready, threadLinked: false })).toBe(false);
    expect(desktopOnboardingDestinationReady({ ...ready, messages: [] })).toBe(false);
    expect(desktopOnboardingDestinationReady({ ...ready, turnStarted: false })).toBe(false);
  });

  it("does not accept somebody else's message as the one that was sent", () => {
    const base = {
      threadLinked: true,
      submittedMessage: "Help me plan the week",
      turnStarted: true,
    };

    expect(
      desktopOnboardingDestinationReady({
        ...base,
        messages: [{ role: "assistant", text: "Help me plan the week" }],
      }),
    ).toBe(false);
    expect(
      desktopOnboardingDestinationReady({
        ...base,
        messages: [{ role: "user", text: "An older message" }],
      }),
    ).toBe(false);
    // The composer trims before it submits, so stored whitespace still matches.
    expect(
      desktopOnboardingDestinationReady({
        ...base,
        messages: [{ role: "user", text: "  Help me plan the week\n" }],
      }),
    ).toBe(true);
  });

  it("falls back to the user turn when the first message is attachments only", () => {
    const base = { threadLinked: true, submittedMessage: "  ", turnStarted: true };

    expect(
      desktopOnboardingDestinationReady({ ...base, messages: [{ role: "user", text: "" }] }),
    ).toBe(true);
    expect(desktopOnboardingDestinationReady({ ...base, messages: [] })).toBe(false);
  });

  it("never starts the fade before the workspace is open behind setup", () => {
    // Readiness can land early on a fast machine; the overlay still has to
    // stay opaque until the workspace it is covering has been opened.
    for (const phase of ["sending", "waking"] as const) {
      expect(
        canStartDesktopOnboardingReveal({ phase, destinationReady: true, timedOut: true }),
      ).toBe(false);
    }
    expect(
      canStartDesktopOnboardingReveal({ phase: null, destinationReady: true, timedOut: false }),
    ).toBe(false);
  });

  it("holds the fade at `opening` until the destination is ready", () => {
    expect(
      canStartDesktopOnboardingReveal({
        phase: "opening",
        destinationReady: false,
        timedOut: false,
      }),
    ).toBe(false);
    expect(
      canStartDesktopOnboardingReveal({
        phase: "opening",
        destinationReady: true,
        timedOut: false,
      }),
    ).toBe(true);
    // Failure safety: a destination that never reports must not trap the user.
    expect(
      canStartDesktopOnboardingReveal({
        phase: "opening",
        destinationReady: false,
        timedOut: true,
      }),
    ).toBe(true);
  });

  it("starts the fade once and does not restart it", () => {
    // The gate closes behind itself, so a re-render mid-fade cannot schedule a
    // second unmount on top of the one already running.
    for (const phase of ["revealing", "done"] as const) {
      expect(
        canStartDesktopOnboardingReveal({ phase, destinationReady: true, timedOut: false }),
      ).toBe(false);
    }
  });

  it("rests the avatar on the send and keeps it working once it wakes", () => {
    expect(desktopOnboardingHandoffAvatarState("sending")).toBe("idle");
    expect(desktopOnboardingHandoffAvatarState("waking")).toBe("working");
    expect(desktopOnboardingHandoffAvatarState("opening")).toBe("working");
    expect(desktopOnboardingHandoffAvatarState("revealing")).toBe("working");
    expect(desktopOnboardingHandoffAvatarState("done")).toBe("working");
  });
});
