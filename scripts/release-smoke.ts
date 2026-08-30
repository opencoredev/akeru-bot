// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import { checkPublicDependencies } from "./check-public-dependencies.ts";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return NodeFS.readFileSync(NodePath.join(repoRoot, relativePath), "utf8");
}

function assertContains(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) throw new Error(message);
}

function assertOmits(haystack: string, needle: string, message: string): void {
  if (haystack.toLowerCase().includes(needle.toLowerCase())) throw new Error(message);
}

const releaseWorkflow = read(".depot/workflows/release.yml");
const ciWorkflow = read(".depot/workflows/ci.yml");
const desktopArtifactBuilder = read("scripts/build-desktop-artifact.ts");
const depotWorkflowDirectory = NodePath.join(repoRoot, ".depot/workflows");

for (const workflowFile of NodeFS.readdirSync(depotWorkflowDirectory)) {
  if (!workflowFile.endsWith(".yml") && !workflowFile.endsWith(".yaml")) continue;
  const workflow = read(NodePath.join(".depot/workflows", workflowFile));
  if (/^\s*(?:runs-on|runner): (?:ubuntu|macos|windows)-/mu.test(workflow)) {
    throw new Error(`Depot workflow still uses a GitHub-hosted runner: ${workflowFile}.`);
  }
}

for (const relativePath of [".github/workflows/ci.yml", ".github/workflows/release.yml"] as const) {
  if (NodeFS.existsSync(NodePath.join(repoRoot, relativePath))) {
    throw new Error(`GitHub Actions still owns ${relativePath}; move it to .depot/workflows.`);
  }
}

assertContains(
  desktopArtifactBuilder,
  'artifactName: "Akeru-Bot-${version}-${arch}.${ext}"',
  "Desktop artifacts do not use the Akeru Bot release name.",
);

for (const [needle, label] of [
  ["label: macOS arm64 DMG", "macOS arm64 DMG"],
  ["label: Windows x64 NSIS", "Windows x64 NSIS"],
  ["label: Linux x64 AppImage", "Linux x64 AppImage"],
  ["runner: depot-macos-15", "Depot macOS runner"],
  ["runner: depot-windows-2025-8", "8-vCPU Depot Windows runner"],
  ["runner: depot-ubuntu-24.04-8", "8-vCPU Depot Linux runner"],
  ["apple-actions/import-codesign-certs@v7", "Developer ID certificate import"],
  ["--signed", "signed macOS build"],
  ["xcrun notarytool submit", "DMG notarization"],
  ["xcrun stapler staple", "DMG ticket stapling"],
  ["codesign --verify", "app signature verification"],
  ["spctl --assess", "Gatekeeper verification"],
  ["vp run --filter t3 build", "CLI and web build"],
  ["--dry-run", "CLI package dry-run"],
  ["vp run --filter @t3tools/marketing typecheck", "marketing typecheck"],
  ["vp run --filter @t3tools/marketing build", "marketing build"],
] as const) {
  assertContains(releaseWorkflow, needle, `Release workflow is missing ${label}.`);
}

for (const [needle, label] of [
  ["clerk", "Clerk configuration"],
  ["relay", "relay configuration"],
  ["publish-aur", "AUR publishing"],
  ["action-gh-release", "GitHub release publishing"],
  ["vercel deploy", "hosted deployment"],
  ["discord", "Discord release announcements"],
  ["T3 Code", "T3 release naming"],
  [".env.example", "T3 environment template"],
] as const) {
  assertOmits(releaseWorkflow, needle, `Release workflow still contains ${label}.`);
}

for (const [needle, label] of [
  ["blacksmith", "private CI runners"],
  ["thread-transfer", "thread transfer reporting"],
  ["mobile_native", "mobile production checks"],
  ["clerk", "Clerk bundle checks"],
] as const) {
  assertOmits(ciWorkflow, needle, `CI workflow still contains ${label}.`);
}

assertContains(ciWorkflow, "runs-on: depot-ubuntu-24.04-8", "CI does not use Depot runners.");
assertOmits(ciWorkflow, "runs-on: ubuntu-24.04", "GitHub-hosted Linux runners");
assertOmits(releaseWorkflow, "runner: macos-15", "GitHub-hosted macOS runner");
assertOmits(releaseWorkflow, "runner: windows-2025", "GitHub-hosted Windows runner");
assertOmits(releaseWorkflow, "runner: ubuntu-24.04", "GitHub-hosted Linux runner");
assertOmits(
  desktopArtifactBuilder,
  'const DESKTOP_APP_ID = "com.t3tools.t3code"',
  "legacy T3 desktop bundle identifier",
);
assertContains(
  desktopArtifactBuilder,
  'const DESKTOP_APP_ID = "dev.leodoes.akeru"',
  "Akeru desktop bundle identifier is missing.",
);

for (const relativePath of [
  ".github/workflows/deploy-relay.yml",
  ".github/workflows/desktop-macos-preview.yml",
  ".github/workflows/mobile-eas-preview.yml",
  ".github/workflows/mobile-eas-production.yml",
  ".github/workflows/mobile-fingerprint-check.yml",
  ".github/workflows/mobile-showcase-screenshots.yml",
  ".github/workflows/publish-aur.yml",
  ".github/workflows/thread-transfer-report.yml",
  ".github/workflows/web-preview.yml",
  ".github/scripts/thread-transfer-report.cjs",
  "packaging/aur/README.md",
] as const) {
  if (NodeFS.existsSync(NodePath.join(repoRoot, relativePath))) {
    throw new Error(`Retired workflow file still exists: ${relativePath}.`);
  }
}

const dependencyProblems = checkPublicDependencies(repoRoot);
if (dependencyProblems.length > 0) {
  throw new Error(
    `Release inputs contain ${dependencyProblems.length} external local dependency path(s).`,
  );
}

const tempRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-release-smoke-"));
try {
  for (const relativePath of [
    "apps/server/package.json",
    "apps/desktop/package.json",
    "apps/web/package.json",
    "packages/contracts/package.json",
  ] as const) {
    const destination = NodePath.join(tempRoot, relativePath);
    NodeFS.mkdirSync(NodePath.dirname(destination), { recursive: true });
    NodeFS.copyFileSync(NodePath.join(repoRoot, relativePath), destination);
  }

  NodeChildProcess.execFileSync(
    process.execPath,
    [
      NodePath.join(repoRoot, "scripts/update-release-package-versions.ts"),
      "9.9.9-smoke.0",
      "--root",
      tempRoot,
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );

  for (const relativePath of [
    "apps/server/package.json",
    "apps/desktop/package.json",
    "apps/web/package.json",
    "packages/contracts/package.json",
  ] as const) {
    const manifest = JSON.parse(readFromTemp(relativePath)) as { readonly version?: unknown };
    if (manifest.version !== "9.9.9-smoke.0") {
      throw new Error(`Release version did not update ${relativePath}.`);
    }
  }
} finally {
  NodeFS.rmSync(tempRoot, { recursive: true, force: true });
}

function readFromTemp(relativePath: string): string {
  return NodeFS.readFileSync(NodePath.join(tempRoot, relativePath), "utf8");
}

Effect.runSync(Console.log("Akeru release smoke checks passed."));
