import { describe, expect, it } from "vite-plus/test";

import { activeChatPaletteActions, registerChatPaletteActions } from "./chatActionsRegistry";

const action = (id: string) => ({ id, title: id, searchTerms: [], run: () => {} });

describe("chat actions registry", () => {
  it("publishes the live owner's actions and ignores a stale owner's cleanup", () => {
    const first = {};
    const second = {};
    const clearFirst = registerChatPaletteActions(first, [action("new")]);
    const clearSecond = registerChatPaletteActions(second, [action("rename")]);
    clearFirst();
    expect(activeChatPaletteActions().map((entry) => entry.id)).toEqual(["rename"]);
    clearSecond();
    expect(activeChatPaletteActions()).toEqual([]);
  });
});
