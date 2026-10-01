#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

// A file-wide `oxlint-disable` also silences akeru/no-lint-suppressions, so CI scans the
// tracked sources directly. Vendored and generated code is fixed at its source instead.
const SUPPRESSION_PATTERN =
  "(//|/\\*+|\\{/\\*+)\\s*((eslint|oxlint)-(disable|enable)|@ts-(ignore|nocheck|expect-error))";

const EXCLUDED_PATHSPECS = [
  ":!.repos/**",
  ":!oxlint-plugin-anti-slop/**",
  ":!**/vendor/**",
  ":!**/_generated/**",
  ":!**/*.gen.ts",
  ":!apps/web/public/mockServiceWorker.js",
  ":!oxlint-plugin-akeru/rules/no-lint-suppressions*.ts",
  ":!scripts/check-lint-suppressions*.ts",
];

export function findLintSuppressions(repoRoot: string): ReadonlyArray<string> {
  const result = NodeChildProcess.spawnSync(
    "git",
    [
      "grep",
      "-nE",
      SUPPRESSION_PATTERN,
      "--",
      "*.ts",
      "*.tsx",
      "*.js",
      "*.jsx",
      "*.mjs",
      "*.cjs",
      ...EXCLUDED_PATHSPECS,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );

  // git grep exits 1 when nothing matches.
  if (result.status === 1) return [];

  if (result.status !== 0) throw new Error(`git grep failed: ${result.stderr}`);

  return result.stdout.split("\n").filter((line) => line.length > 0);
}

if (import.meta.url === NodeURL.pathToFileURL(process.argv[1] ?? "").href) {
  const matches = findLintSuppressions(process.cwd());

  if (matches.length > 0) {
    console.error(
      `Found ${matches.length} lint or type suppression comments. Fix the code instead; see docs/internals/lint.md.\n${matches.join("\n")}`,
    );
    process.exit(1);
  }
}
