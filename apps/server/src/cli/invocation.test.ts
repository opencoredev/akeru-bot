import { assert, it } from "@effect/vitest";

import { detectCliRunner, formatCliCommand, suggestedPackageSpec } from "./invocation.ts";

it("detects package runners from their cache entry paths", () => {
  assert.equal(
    detectCliRunner("/home/leo/.npm/_npx/abc123/node_modules/akeru-bot/dist/bin.mjs"),
    "npx",
  );
  assert.equal(
    detectCliRunner(
      "C:\\Users\\leo\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\akeru-bot\\dist\\bin.mjs",
    ),
    "npx",
  );
  assert.equal(
    detectCliRunner("/home/leo/.cache/pnpm/dlx/abc/node_modules/akeru-bot/dist/bin.mjs"),
    "pnpm dlx",
  );
  assert.equal(
    detectCliRunner(
      "/home/leo/.local/share/pnpm/.pnpm/dlx/abc/node_modules/akeru-bot/dist/bin.mjs",
    ),
    "pnpm dlx",
  );
  assert.equal(
    detectCliRunner(
      "C:\\Users\\leo\\AppData\\Local\\pnpm-cache\\dlx\\abc\\node_modules\\akeru-bot\\dist\\bin.mjs",
    ),
    "pnpm dlx",
  );
  assert.equal(
    detectCliRunner("/home/leo/.bun/install/cache/akeru-bot@0.0.31/dist/bin.mjs"),
    "bunx",
  );
  assert.equal(
    detectCliRunner("/tmp/bunx-1000-akeru-bot@latest/node_modules/akeru-bot/dist/bin.mjs"),
    "bunx",
  );
  assert.equal(
    detectCliRunner(
      "C:\\Users\\leo\\AppData\\Local\\Temp\\bunx-0-akeru-bot@latest\\node_modules\\akeru-bot\\dist\\bin.mjs",
    ),
    "bunx",
  );
});

it("treats stable installs as direct invocations", () => {
  assert.isNull(detectCliRunner("/usr/local/lib/node_modules/akeru-bot/dist/bin.mjs"));
  assert.isNull(detectCliRunner("/home/leo/Code/work/akeru-bot/apps/server/dist/bin.mjs"));
  assert.isNull(
    detectCliRunner("/home/leo/.akeru/runtime/0.0.31/node_modules/akeru-bot/dist/bin.mjs"),
  );
  assert.isNull(detectCliRunner(""));
});

it("re-suggests the nightly channel only for nightly builds", () => {
  assert.equal(suggestedPackageSpec("0.0.31-nightly.20260729"), "akeru-bot@nightly");
  assert.equal(suggestedPackageSpec("0.0.31"), "akeru-bot");
});

it("formats serve suggestions to match the launching command", () => {
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/home/leo/.npm/_npx/abc/node_modules/akeru-bot/dist/bin.mjs",
      version: "0.0.31-nightly.20260729",
    }),
    "npx akeru-bot@nightly serve",
  );
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/tmp/bunx-1000-akeru-bot@latest/node_modules/akeru-bot/dist/bin.mjs",
      version: "0.0.31",
    }),
    "bunx akeru-bot serve",
  );
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/usr/local/lib/node_modules/akeru-bot/dist/bin.mjs",
      version: "0.0.31-nightly.20260729",
    }),
    "akeru serve",
  );
});
