import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

const repoRoot = NodePath.resolve(import.meta.dirname, "../../..");

describe("mobile legal assets", () => {
  it("bundles every checked-in license file", () => {
    const source = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "legalAssets.ts"),
      "utf8",
    );
    const licenses = NodeFS.readdirSync(NodePath.join(repoRoot, "legal/licenses")).sort();

    expect(source).toContain('require("../../../LICENSE")');
    expect(source).toContain('require("../../../THIRD_PARTY_NOTICES.md")');
    for (const license of licenses) {
      expect(source).toContain(`require("../../../legal/licenses/${license}")`);
    }
  });
});
