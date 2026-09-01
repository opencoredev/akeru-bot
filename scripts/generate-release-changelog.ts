import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";

export interface ReleaseChange {
  number: number;
  title: string;
}

const stableTag = /^v\d+\.\d+\.\d+$/;
const pullRequestCommit = /^(?<title>.+) \(#(?<number>\d+)\)$/;
const releaseManifests = [
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
] as const;

export function parseReleaseChanges(log: string): ReleaseChange[] {
  const seen = new Set<number>();
  return log
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((subject) => {
      const match = subject.match(pullRequestCommit);
      if (!match?.groups) return [];
      const number = Number(match.groups.number);
      if (seen.has(number)) return [];
      seen.add(number);

      return [
        {
          number,
          title: match.groups.title,
        },
      ];
    });
}

export function renderReleaseChangelog(changes: ReleaseChange[]): string {
  const entries = changes.map(
    ({ number, title }) =>
      `- [#${number}](https://github.com/opencoredev/akeru-bot/pull/${number}) ${title}`,
  );

  return [
    "---",
    "packages:",
    "  group:akeru:",
    "    type: patch",
    "---",
    "",
    "### Changes",
    "",
    ...entries,
    "",
  ].join("\n");
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function latestStableTag(): string | undefined {
  return git(
    "for-each-ref",
    "--merged=HEAD",
    "--sort=-creatordate",
    "--format=%(refname:short)",
    "refs/tags",
  )
    .split("\n")
    .find((tag) => stableTag.test(tag));
}

function packageVersion(ref: string, path: string): string | undefined {
  try {
    const manifest = JSON.parse(git("show", `${ref}:${path}`)) as {
      version?: unknown;
    };
    return typeof manifest.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

function isVersionRelease(ref: string): boolean {
  const before = releaseManifests.map((path) => packageVersion(`${ref}^`, path));
  const after = releaseManifests.map((path) => packageVersion(ref, path));
  return (
    before.every(Boolean) &&
    after.every(Boolean) &&
    new Set(before).size === 1 &&
    new Set(after).size === 1 &&
    before[0] !== after[0]
  );
}

export function headIsVersionRelease(): boolean {
  return isVersionRelease("HEAD");
}

function latestVersionReleaseCommit(): string | undefined {
  return git("log", "--first-parent", "--format=%H", "--", ...releaseManifests)
    .split("\n")
    .find(isVersionRelease);
}

export function readReleaseChanges(): ReleaseChange[] {
  const boundary = latestStableTag() ?? latestVersionReleaseCommit();
  const range = boundary ? [`${boundary}..HEAD`] : [];
  const log = git("log", "--first-parent", "--format=%s", ...range);
  return parseReleaseChanges(log).reverse();
}

async function main(): Promise<void> {
  if (!process.argv.includes("--force") && headIsVersionRelease()) {
    console.log("The version PR merge does not need another version PR.");
    return;
  }

  const changes = readReleaseChanges();
  if (changes.length === 0) {
    console.log("No merged pull requests need a release changelog.");
    return;
  }

  await mkdir(".tegami", { recursive: true });
  await writeFile(".tegami/stable-release.md", renderReleaseChangelog(changes));
  console.log(`Added ${changes.length} merged pull requests to the release changelog.`);
}

if (import.meta.main) {
  await main();
}
