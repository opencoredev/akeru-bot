import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { OnboardingHandoff } from "./OnboardingHandoff";
import {
  DEFAULT_DESKTOP_ONBOARDING_DRAFT,
  DESKTOP_ONBOARDING_HANDOFF_PHASES,
  type DesktopOnboardingHandoffPhase,
} from "./desktopOnboarding.logic";

const draft = {
  ...DEFAULT_DESKTOP_ONBOARDING_DRAFT,
  step: "message" as const,
  name: "Wander",
  botId: "bot-1",
};

function markup(phase: DesktopOnboardingHandoffPhase) {
  return renderToStaticMarkup(
    <OnboardingHandoff
      draft={draft}
      message="Help me plan the week"
      phase={phase}
      displayName="Wander"
    />,
  );
}

describe("onboarding handoff", () => {
  it("keeps the sent message on screen through every beat", () => {
    for (const phase of DESKTOP_ONBOARDING_HANDOFF_PHASES) {
      expect(markup(phase)).toContain("Help me plan the week");
    }
  });

  it("narrates each beat and plays the matching avatar state", () => {
    expect(markup("sending")).toContain("Message sent");
    expect(markup("sending")).toContain('data-bot-state="idle"');

    expect(markup("waking")).toContain("Waking Wander up");
    expect(markup("waking")).toContain('data-bot-state="working"');

    expect(markup("opening")).toContain("Opening your workspace");
    expect(markup("opening")).toContain('data-bot-state="working"');
  });

  it("holds the scene still while setup fades off the workspace", () => {
    // Setup leaves as one layer, so nothing inside it may move between the
    // beat the workspace mounts behind setup and the beat setup unmounts.
    const opening = markup("opening");

    expect(markup("revealing")).toBe(opening);
    expect(markup("done")).toBe(opening);
  });

  it("shimmers the status briefly rather than for the whole wait", () => {
    expect(markup("waking")).toContain("bot-status-shimmer bot-status-shimmer-finite");
  });

  it("truncates a long bot name instead of overflowing the row", () => {
    const html = renderToStaticMarkup(
      <OnboardingHandoff
        draft={draft}
        message="Help me plan the week"
        phase="waking"
        displayName={"A".repeat(80)}
      />,
    );
    expect(html).toContain(`Waking ${"A".repeat(80)} up`);
    expect(html).not.toContain("whitespace-nowrap");
    expect(html.match(/\btruncate\b/g)).toHaveLength(2);
  });

  it("reserves the widest line so a status swap never resizes the row", () => {
    // The hidden sizer is present on every beat, including the shortest line.
    for (const phase of DESKTOP_ONBOARDING_HANDOFF_PHASES) {
      const html = markup(phase);
      expect(html).toContain("Opening your workspace");
      expect(html).toContain("invisible");
    }
  });
});
