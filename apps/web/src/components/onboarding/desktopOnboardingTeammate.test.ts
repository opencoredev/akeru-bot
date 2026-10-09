import { describe, expect, it } from "vite-plus/test";

import {
  DESKTOP_ONBOARDING_TEAMMATE_NAMES,
  desktopOnboardingDefaultProjectCreateInput,
  pickDesktopOnboardingTeammateName,
  workspaceTitleFromCwd,
} from "./desktopOnboardingTeammate";

describe("desktop onboarding teammate", () => {
  it("picks a curated adult name and skips names already in the roster", () => {
    expect(DESKTOP_ONBOARDING_TEAMMATE_NAMES).toContain("Nova");
    expect(DESKTOP_ONBOARDING_TEAMMATE_NAMES).toContain("Scout");
    expect(DESKTOP_ONBOARDING_TEAMMATE_NAMES).toContain("Dispatch");
    expect(pickDesktopOnboardingTeammateName(["Nova", "Scout"], () => 0)).toBe("Dispatch");
    expect(pickDesktopOnboardingTeammateName(["nova"], () => 0)).toBe("Scout");
  });

  it("still names a teammate when every curated name is taken", () => {
    expect(pickDesktopOnboardingTeammateName(DESKTOP_ONBOARDING_TEAMMATE_NAMES, () => 0)).toBe(
      "Nova",
    );
  });

  it("creates a default project only after bootstrap when none exist", () => {
    expect(
      desktopOnboardingDefaultProjectCreateInput({
        bootstrapped: false,
        projectCount: 0,
        cwd: "/Users/leo/code/akeru",
        projectId: "project-1",
      }),
    ).toBeNull();
    expect(
      desktopOnboardingDefaultProjectCreateInput({
        bootstrapped: true,
        projectCount: 1,
        cwd: "/Users/leo/code/akeru",
        projectId: "project-1",
      }),
    ).toBeNull();
    expect(
      desktopOnboardingDefaultProjectCreateInput({
        bootstrapped: true,
        projectCount: 0,
        cwd: "/Users/leo/code/akeru",
        projectId: "project-1",
      }),
    ).toEqual({
      projectId: "project-1",
      title: "akeru",
      workspaceRoot: "/Users/leo/code/akeru",
    });
  });

  it("titles a workspace from unix or windows cwd", () => {
    expect(workspaceTitleFromCwd("/Users/leo/code/akeru-bot")).toBe("akeru-bot");
    expect(workspaceTitleFromCwd("C:\\Users\\leo\\code\\akeru-bot\\")).toBe("akeru-bot");
    expect(workspaceTitleFromCwd("/")).toBe("project");
  });
});
