import { ProviderDriverKind, type ServerProviderSkill } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildComposerProviderMenuItems,
  composerProviderMenuItemText,
  type ComposerProviderCatalog,
} from "./composerProviderMenuItems";

const skill = (name: string, enabled = true): ServerProviderSkill => ({
  name,
  path: `/skills/${name}/SKILL.md`,
  enabled,
});

// The five built-in drivers. The menu must behave the same whichever one runs the turn.
const DRIVER_KINDS = ["codex", "claudeAgent", "grok", "kimi", "opencode"] as const;

describe("buildComposerProviderMenuItems", () => {
  it("returns nothing without a catalog", () => {
    expect(
      buildComposerProviderMenuItems({
        trigger: { kind: "skill", query: "" },
        catalog: null,
        showSkillsInSlashMenu: true,
      }),
    ).toEqual([]);
  });
});

describe.each(DRIVER_KINDS)("buildComposerProviderMenuItems for %s", (kind) => {
  const catalog: ComposerProviderCatalog = {
    provider: ProviderDriverKind.make(kind),
    skills: [skill("review"), skill("deploy"), skill("archived", false)],
    slashCommands: [{ name: "compact", description: "Compact context" }, { name: "review" }],
  };

  it("ranks $ skills by the typed query", () => {
    const items = buildComposerProviderMenuItems({
      trigger: { kind: "skill", query: "dep" },
      catalog,
      showSkillsInSlashMenu: true,
    });
    expect(items.map((item) => item.id)).toEqual([`skill:${kind}:deploy`]);
    expect(items[0]?.provider).toBe(kind);
    expect(items[0] && composerProviderMenuItemText(items[0])).toBe("$deploy ");
  });

  it("lists / commands, with enabled skills replacing same-named commands", () => {
    const items = buildComposerProviderMenuItems({
      trigger: { kind: "slash-command", query: "" },
      catalog,
      showSkillsInSlashMenu: true,
    });
    expect(items.map((item) => item.label)).toEqual(["/compact", "/skill:review", "/skill:deploy"]);
    expect(items[0] && composerProviderMenuItemText(items[0])).toBe("/compact ");
    expect(items.every((item) => item.provider === kind)).toBe(true);
  });

  it("keeps skills out of the / menu when the setting is off", () => {
    const items = buildComposerProviderMenuItems({
      trigger: { kind: "slash-command", query: "" },
      catalog,
      showSkillsInSlashMenu: false,
    });
    expect(items.map((item) => item.label)).toEqual(["/compact", "/review"]);
  });
});
