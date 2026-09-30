import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

const repoRoot = NodePath.resolve(import.meta.dirname, "../../..");

// Hermes on our Expo SDK 56 / RN 0.85 build ships no ES2023 change-by-copy
// methods and no ES2024/ES2025 additions. Keep the mobile-reachable workspace
// sources off them; new call sites crash the Android client at render.
const scannedRoots = [
  "apps/mobile/src",
  "apps/mobile/modules",
  "packages/client-runtime/src",
  "packages/shared/src",
  "packages/contracts/src",
];

const forbiddenPatterns: ReadonlyArray<{
  readonly name: string;
  readonly pattern: RegExp;
}> = [
  { name: "Array#toSorted", pattern: /\.toSorted\s*\(/ },
  { name: "Array#toReversed", pattern: /\.toReversed\s*\(/ },
  { name: "Array#toSpliced", pattern: /\.toSpliced\s*\(/ },
  { name: "Array#with", pattern: /\.with\s*\(/ },
  { name: "Array.fromAsync", pattern: /\bArray\.fromAsync\s*\(/ },
  { name: "Object.groupBy", pattern: /\bObject\.groupBy\s*\(/ },
  { name: "Map.groupBy", pattern: /\bMap\.groupBy\s*\(/ },
  { name: "Set#union", pattern: /\.union\s*\(/ },
  { name: "Set#intersection", pattern: /\.intersection\s*\(/ },
  { name: "Set#difference", pattern: /\.difference\s*\(/ },
  { name: "Set#symmetricDifference", pattern: /\.symmetricDifference\s*\(/ },
  { name: "Set#isSubsetOf", pattern: /\.isSubsetOf\s*\(/ },
  { name: "Set#isSupersetOf", pattern: /\.isSupersetOf\s*\(/ },
  { name: "Set#isDisjointFrom", pattern: /\.isDisjointFrom\s*\(/ },
];

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
    const full = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* sourceFiles(full);
    } else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      yield full;
    }
  }
}

describe("Hermes ES2023 compatibility", () => {
  it("mobile-reachable sources avoid array/set/map methods Hermes lacks", () => {
    const offenders: string[] = [];
    for (const root of scannedRoots) {
      for (const file of sourceFiles(NodePath.join(repoRoot, root))) {
        if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
        const source = NodeFS.readFileSync(file, "utf8")
          .replace(/\/\/[^\n]*/g, "")
          .replace(/\/\*[\s\S]*?\*\//g, "");
        for (const { name, pattern } of forbiddenPatterns) {
          if (pattern.test(source)) {
            offenders.push(`${NodePath.relative(repoRoot, file)} uses ${name}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
