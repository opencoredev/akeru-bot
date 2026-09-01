import { describe, expect, it } from "vite-plus/test";

import { canCreateGroup } from "./NewGroupDialog";

describe("new group", () => {
  it("requires a name, two distinct bots, and a selected boss", () => {
    expect(canCreateGroup("Launch crew", ["one", "two"], "one")).toBe(true);
    expect(canCreateGroup("Launch crew", ["one"], "one")).toBe(false);
    expect(canCreateGroup("Launch crew", ["one", "one"], "one")).toBe(false);
    expect(canCreateGroup(" ", ["one", "two"], "one")).toBe(false);
    expect(canCreateGroup("Launch crew", ["one", "two"], "three")).toBe(false);
  });
});
