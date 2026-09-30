import { describe, expect, it } from "vite-plus/test";
import { filterCommandPaletteGroups, type CommandPaletteGroup } from "./CommandPalette.logic";

function action(value: string, searchTerms: ReadonlyArray<string>) {
  return { value, searchTerms, title: value, icon: null, run: async () => undefined };
}

const ACTIONS: CommandPaletteGroup = {
  value: "actions",
  label: "Actions",
  items: [
    action("action:theme-editor", ["theme", "appearance", "colors"]),
    action("action:settings", ["settings", "preferences", "keybindings"]),
    action("action:plugins", ["plugins", "mcp", "tools"]),
  ],
};

describe("filterCommandPaletteGroups", () => {
  it("returns every group for an empty query", () => {
    expect(filterCommandPaletteGroups({ groups: [ACTIONS], query: "  " })).toEqual([ACTIONS]);
  });

  it("keeps only matching items and drops empty groups", () => {
    const groups = filterCommandPaletteGroups({ groups: [ACTIONS], query: "sett" });
    expect(groups.map((group) => group.items.map((item) => item.value))).toEqual([
      ["action:settings"],
    ]);
    expect(filterCommandPaletteGroups({ groups: [ACTIONS], query: "nothing" })).toEqual([]);
  });

  it("ranks earlier search terms ahead of later ones", () => {
    const group: CommandPaletteGroup = {
      value: "actions",
      label: "Actions",
      items: [action("later", ["open", "theme"]), action("first", ["theme", "open"])],
    };
    const groups = filterCommandPaletteGroups({ groups: [group], query: "theme" });
    expect(groups[0]?.items.map((item) => item.value)).toEqual(["first", "later"]);
  });

  it("ignores a leading > so actions-style queries still match", () => {
    const groups = filterCommandPaletteGroups({ groups: [ACTIONS], query: ">plugins" });
    expect(groups[0]?.items.map((item) => item.value)).toEqual(["action:plugins"]);
  });
});
