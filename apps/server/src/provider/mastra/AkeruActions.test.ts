import { describe, expect, it } from "vite-plus/test";
import { akeruToolCategory, permissionPolicy } from "./AkeruActions.ts";

describe("akeruToolCategory", () => {
  it("keeps Auto-accept edits from approving Akeru account changes", () => {
    for (const toolName of ["RemoveMcpAccount", "RenameMcpAccount"]) {
      expect(permissionPolicy("auto-accept-edits", akeruToolCategory(toolName))).toBe("ask");
    }

    expect(permissionPolicy("auto-accept-edits", akeruToolCategory("write_file"))).toBe("allow");
  });
});
