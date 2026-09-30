import { describe, expect, it } from "vite-plus/test";

import type { ServerProviderSkill } from "@akeru/contracts";

import { searchProviderSkills } from "./providerSkillSearch";

function makeSkill(input: Partial<ServerProviderSkill> & Pick<ServerProviderSkill, "name">) {
  return {
    path: `/tmp/${input.name}/SKILL.md`,
    enabled: true,
    ...input,
  } satisfies ServerProviderSkill;
}

describe("searchProviderSkills", () => {
  it("moves exact ui matches ahead of broader ui matches", () => {
    const skills = [
      makeSkill({
        name: "agent-browser",
        displayName: "Agent Browser",
        shortDescription: "Browser automation CLI for AI agents",
      }),
      makeSkill({
        name: "building-native-ui",
        displayName: "Building Native Ui",
        shortDescription: "Complete guide for building beautiful apps with Expo Router",
      }),
      makeSkill({
        name: "ui",
        displayName: "Ui",
        shortDescription: "Explore, build, and refine UI.",
      }),
    ];

    expect(searchProviderSkills(skills, "ui").map((skill) => skill.name)).toEqual([
      "ui",
      "building-native-ui",
    ]);
  });

  it("ranks the same with or without skill icons", () => {
    const plain = [
      makeSkill({ name: "agent-browser", displayName: "Agent Browser" }),
      makeSkill({ name: "building-native-ui", displayName: "Building Native Ui" }),
      makeSkill({ name: "ui", displayName: "Ui" }),
    ];
    const withIcons = plain.map((skill, index) => ({
      ...skill,
      icon: ["🌐", "🧱", "/icons/ui.png"][index],
    }));

    for (const query of ["", "ui", "bni", "browser"]) {
      expect(searchProviderSkills(withIcons, query).map((skill) => skill.name)).toEqual(
        searchProviderSkills(plain, query).map((skill) => skill.name),
      );
    }
  });

  it("uses fuzzy ranking for abbreviated queries", () => {
    const skills = [
      makeSkill({ name: "gh-fix-ci", displayName: "Gh Fix Ci" }),
      makeSkill({ name: "github", displayName: "Github" }),
      makeSkill({ name: "agent-browser", displayName: "Agent Browser" }),
    ];

    expect(searchProviderSkills(skills, "gfc").map((skill) => skill.name)).toEqual(["gh-fix-ci"]);
  });

  it("omits disabled skills from results", () => {
    const skills = [
      makeSkill({ name: "ui", displayName: "Ui", enabled: false }),
      makeSkill({ name: "frontend-design", displayName: "Frontend Design" }),
    ];

    expect(searchProviderSkills(skills, "ui").map((skill) => skill.name)).toEqual([]);
  });

  it("returns every enabled skill for an empty query", () => {
    const skills = [
      makeSkill({ name: "unslop" }),
      makeSkill({ name: "browser" }),
      makeSkill({ name: "disabled", enabled: false }),
    ];

    expect(searchProviderSkills(skills, "").map((skill) => skill.name)).toEqual([
      "unslop",
      "browser",
    ]);
  });
});
