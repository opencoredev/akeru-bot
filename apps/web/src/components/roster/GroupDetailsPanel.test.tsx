// @effect-diagnostics nodeBuiltinImport:off - The route contract reads its source.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

describe("GroupDetailsPanel", () => {
  it("uses the bot sidebar behavior and group management commands", () => {
    const source = NodeFS.readFileSync(new URL("./GroupDetailsPanel.tsx", import.meta.url), "utf8");
    expect(source).toContain('resolveShortcutCommand(event, keybindings) !== "rightPanel.toggle"');
    expect(source).toContain("RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY");
    expect(source).toContain("botEnvironment.groups.rename");
    expect(source).toContain("botEnvironment.groups.assignMember");
    expect(source).toContain("botEnvironment.groups.unassignMember");
    expect(source).toContain("botEnvironment.groups.setBoss");
    expect(source).toContain("botEnvironment.groups.delete");
    expect(source).toContain("members.length <= 2");
  });

  it("mounts beside the group conversation", () => {
    const source = NodeFS.readFileSync(
      new URL("../../routes/_chat.groups.$groupId.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("<GroupThreadLanding");
    expect(source).toContain("<GroupDetailsPanel");
    expect(source).toContain("onDeleted=");
  });
});
