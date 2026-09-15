// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Release selection runs before an Effect runtime exists.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

export interface NightlyReleasePlan {
  readonly publish: boolean;
  readonly version?: string;
  readonly tag?: string;
}

export interface NightlyReleaseInput {
  readonly stableVersion: string;
  readonly headSha: string;
  readonly previousSha?: string;
  readonly runId: string;
  readonly runAttempt: string;
  readonly previousIsAncestor?: boolean;
}

export function planNightlyRelease(input: NightlyReleaseInput): NightlyReleasePlan {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(input.stableVersion)) {
    throw new Error(`Stable release version is invalid: ${input.stableVersion}.`);
  }
  if (!/^[0-9a-f]{7,40}$/u.test(input.headSha)) {
    throw new Error(`Nightly head SHA is invalid: ${input.headSha}.`);
  }
  if (!/^\d+$/u.test(input.runId) || !/^\d+$/u.test(input.runAttempt)) {
    throw new Error("Nightly run identity must be numeric.");
  }
  if (input.previousSha === input.headSha) return { publish: false };
  if (input.previousSha && input.previousIsAncestor === false) {
    throw new Error("The latest successful nightly is not an ancestor of main.");
  }

  const version = `${input.stableVersion}-nightly.${input.runId}.${input.runAttempt}.g${input.headSha.slice(0, 12)}`;
  return { publish: true, version, tag: `nightly-v${version}` };
}

function gitIsAncestor(previousSha: string, headSha: string): boolean {
  return (
    NodeChildProcess.spawnSync("git", ["merge-base", "--is-ancestor", previousSha, headSha])
      .status === 0
  );
}

function main(): void {
  const [stableVersion, headSha, previousShaArgument, runId, runAttempt] = process.argv.slice(2);
  if (!stableVersion || !headSha || !runId || !runAttempt) {
    throw new Error(
      "Usage: node scripts/nightly-release.ts <stable-version> <head-sha> <previous-sha|-> <run-id> <run-attempt>",
    );
  }
  const previousSha =
    previousShaArgument && previousShaArgument !== "-" ? previousShaArgument : undefined;
  const plan = planNightlyRelease({
    stableVersion,
    headSha,
    runId,
    runAttempt,
    ...(previousSha
      ? { previousSha, previousIsAncestor: gitIsAncestor(previousSha, headSha) }
      : {}),
  });
  const output = [`publish=${String(plan.publish)}`];
  if (plan.version && plan.tag) output.push(`version=${plan.version}`, `tag=${plan.tag}`);
  const rendered = `${output.join("\n")}\n`;
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) NodeFS.appendFileSync(outputPath, rendered);
  else process.stdout.write(rendered);
}

if (import.meta.url === NodeURL.pathToFileURL(process.argv[1] ?? "").href) main();
