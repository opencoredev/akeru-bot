// @effect-diagnostics nodeBuiltinImport:off - The query contract reads its source.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { filterCommandPaletteGroups, type CommandPaletteGroup } from "./CommandPalette.logic";

/*
 * The unit project runs in node with no DOM, so typing then pressing Enter
 * cannot be driven here. These check the two halves: rows for a new query hold
 * nothing from the previous one, and the palette derives its rows from the same
 * query state the input renders, with no deferred copy that can lag behind it.
 */

const item = (value: string, title: string) => ({
  value,
  searchTerms: [title],
  title,
  icon: null,
  run: async () => undefined,
});
const groups: CommandPaletteGroup[] = [
  {
    value: "actions",
    label: "Actions",
    items: [item("action:settings", "Open settings"), item("action:usage", "Open usage")],
  },
];

describe("command palette query", () => {
  it("drops the previous query's first row as soon as the query changes", () => {
    const first = (query: string) =>
      filterCommandPaletteGroups({ groups, query })[0]?.items[0]?.value;
    expect(first("open")).toBe("action:settings");
    expect(first("open u")).toBe("action:usage");
  });

  it("filters rows with the query the input shows", () => {
    const source = NodeFS.readFileSync(new URL("./CommandPalette.tsx", import.meta.url), "utf8");
    expect(source).not.toContain("useDeferredValue");
    expect(source).toContain("useChatSearchItems(query)");
    expect(source).toContain("filterCommandPaletteGroups({ groups, query })");
    expect(source).toContain("value={query}");
  });
});
