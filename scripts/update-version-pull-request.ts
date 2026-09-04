// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Release automation runs before an Effect runtime exists.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  headIsVersionRelease,
  readReleaseChanges,
  type ReleaseChange,
} from "./generate-release-changelog.ts";

const repository = "opencoredev/akeru-bot";
const versionBranch = "tegami/version-packages";
const versionTitle = "Version Packages";

interface CommandResult {
  readonly status: number;
  readonly output: string;
}

function run(command: string, args: ReadonlyArray<string>): CommandResult {
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    env: process.env,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  process.stdout.write(output);
  return { status: result.status ?? 1, output };
}

function runOrThrow(command: string, args: ReadonlyArray<string>): string {
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with code ${result.status ?? 1}:\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

export function nextPatchVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!match) throw new Error(`Stable release version is invalid: ${version}.`);
  const [, major, minor, patch] = match;
  return `${major}.${minor}.${Number(patch) + 1}`;
}

export function renderVersionPullRequestBody(
  currentVersion: string,
  changes: ReadonlyArray<ReleaseChange>,
): string {
  const nextVersion = nextPatchVersion(currentVersion);
  const entries = changes.map(
    ({ number, title }) =>
      `- [#${number}](https://github.com/opencoredev/akeru-bot/pull/${number}) ${title}`,
  );

  return [
    "## Summary",
    "",
    `Prepare Akeru Bot v${nextVersion}.`,
    "",
    "## Changes",
    "",
    ...entries,
    "",
    "## Packages",
    "",
    `- \`@t3tools/desktop\`: \`${currentVersion}\` → \`${nextVersion}\``,
    `- \`akeru-bot\`: \`${currentVersion}\` → \`${nextVersion}\``,
    `- \`@t3tools/web\`: \`${currentVersion}\` → \`${nextVersion}\``,
    `- \`@t3tools/contracts\`: \`${currentVersion}\` → \`${nextVersion}\``,
    "",
  ].join("\n");
}

export function isRecoverableVersionRequestFailure(output: string): boolean {
  const normalized = output.replace(/\s+/gu, " ");
  return (
    normalized.includes('Plugin "github:version-request" failed') &&
    (normalized.includes("A pull request already exists") ||
      normalized.includes("GitHub Actions is not permitted to create or approve pull requests"))
  );
}

function readCurrentVersion(): string {
  const manifest = JSON.parse(NodeFS.readFileSync("apps/server/package.json", "utf8")) as {
    readonly version?: unknown;
  };
  if (typeof manifest.version !== "string") {
    throw new Error("apps/server/package.json does not contain a version.");
  }
  return manifest.version;
}

function findVersionPullRequest(): number | undefined {
  const value = runOrThrow("gh", [
    "pr",
    "list",
    "--repo",
    repository,
    "--state",
    "open",
    "--head",
    versionBranch,
    "--json",
    "number",
    "--jq",
    ".[0].number // empty",
  ]);
  if (value === "") return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`GitHub returned an invalid version pull request number: ${value}.`);
  }
  return number;
}

function verifyVersionBranchIncludesMain(mainSha: string): void {
  runOrThrow("git", [
    "fetch",
    "origin",
    `refs/heads/${versionBranch}:refs/remotes/origin/${versionBranch}`,
  ]);
  runOrThrow("git", [
    "merge-base",
    "--is-ancestor",
    mainSha,
    `refs/remotes/origin/${versionBranch}`,
  ]);
}

function main(): void {
  if (headIsVersionRelease()) {
    console.log("The version pull request merge does not need another version pull request.");
    return;
  }

  const mainSha = process.env.GITHUB_SHA;
  if (!mainSha) throw new Error("GITHUB_SHA is required.");

  const changes = readReleaseChanges();
  if (changes.length === 0) {
    console.log("No merged pull requests need a version pull request.");
    return;
  }

  const body = renderVersionPullRequestBody(readCurrentVersion(), changes);
  const bodyPath = NodePath.join(
    process.env.RUNNER_TEMP ?? NodeOS.tmpdir(),
    "akeru-version-pull-request.md",
  );
  NodeFS.writeFileSync(bodyPath, body);

  const changelog = run("vp", ["run", "release:changelog"]);
  if (changelog.status !== 0) {
    throw new Error("Failed to generate the stable release changelog.");
  }

  const tegami = run("vp", ["run", "tegami", "version", "--no-checks"]);
  const pullRequest = findVersionPullRequest();
  if (!pullRequest) {
    throw new Error(
      tegami.status === 0
        ? "Tegami completed without an open version pull request."
        : `Tegami failed before it created the version pull request:\n${tegami.output}`,
    );
  }
  if (tegami.status !== 0 && !isRecoverableVersionRequestFailure(tegami.output)) {
    throw new Error(`Tegami failed while updating the version pull request:\n${tegami.output}`);
  }

  verifyVersionBranchIncludesMain(mainSha);
  runOrThrow("gh", [
    "pr",
    "edit",
    String(pullRequest),
    "--repo",
    repository,
    "--title",
    versionTitle,
    "--body-file",
    bodyPath,
  ]);
  runOrThrow("gh", ["workflow", "run", "ci.yml", "--repo", repository, "--ref", versionBranch]);
  console.log(`Updated version pull request #${pullRequest} and started Repository checks.`);
}

if (import.meta.url === NodeURL.pathToFileURL(process.argv[1] ?? "").href) main();
