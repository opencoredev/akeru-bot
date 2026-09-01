import { describe, expect, it } from "vite-plus/test";

import desktopPackage from "../apps/desktop/package.json" with { type: "json" };
import serverPackage from "../apps/server/package.json" with { type: "json" };
import webPackage from "../apps/web/package.json" with { type: "json" };
import contractsPackage from "../packages/contracts/package.json" with { type: "json" };
import { releasePackageNames } from "./tegami.ts";

describe("Tegami release packages", () => {
  it("keeps every release package on one stable version", () => {
    expect(releasePackageNames).toEqual([
      "akeru-bot",
      "@t3tools/contracts",
      "@t3tools/desktop",
      "@t3tools/web",
    ]);

    const versions = [
      serverPackage.version,
      contractsPackage.version,
      desktopPackage.version,
      webPackage.version,
    ];
    expect(new Set(versions)).toEqual(new Set(["0.0.34"]));
    expect(versions.every((version) => /^\d+\.\d+\.\d+$/.test(version))).toBe(true);
  });
});
