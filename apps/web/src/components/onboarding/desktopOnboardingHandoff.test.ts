import { describe, expect, it } from "vite-plus/test";

import {
  DESKTOP_ONBOARDING_CELEBRATION_PIECES,
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
} from "./desktopOnboardingHandoff";

describe("desktop onboarding handoff", () => {
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
