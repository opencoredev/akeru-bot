// @effect-diagnostics nodeBuiltinImport:off - Tests inspect repository policy files.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";

type Step = {
  readonly id?: string;
  readonly if?: string;
  readonly run?: string;
};

type Job = {
  readonly if?: string;
  readonly "runs-on": string;
  readonly steps: ReadonlyArray<Step>;
};

type Workflow = {
  readonly on: Record<string, unknown>;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly concurrency?: {
    readonly group?: string;
    readonly "cancel-in-progress"?: boolean;
  };
  readonly jobs: Record<string, Job>;
};

function workflow(path: string): Workflow {
  return parse(NodeFS.readFileSync(new URL(`../${path}`, import.meta.url), "utf8")) as Workflow;
}

describe("CI workflow budget", () => {
  it("validates ready pull requests in one 4-vCPU job", () => {
    const ci = workflow(".github/workflows/ci.yml");
    const commands = Object.values(ci.jobs).flatMap((job) =>
      job.steps.flatMap((step) => (step.run ? [step.run] : [])),
    );

    expect(Object.keys(ci.on)).toEqual(["pull_request", "workflow_dispatch"]);
    expect(ci.on.pull_request).toEqual({
      types: ["opened", "synchronize", "reopened", "ready_for_review"],
    });
    expect(ci.on).not.toHaveProperty("push");
    expect(ci.on).not.toHaveProperty("merge_group");
    expect(ci.concurrency?.group).toBe("ci-${{ github.event.pull_request.number || github.ref }}");
    expect(ci.concurrency?.["cancel-in-progress"]).toBe(true);
    expect(Object.keys(ci.jobs)).toEqual(["check"]);
    expect(ci.jobs.check?.if).toBe(
      "${{ github.event_name == 'workflow_dispatch' || github.event.pull_request.draft == false }}",
    );
    expect(ci.jobs.check?.["runs-on"]).toBe("tenki-standard-medium-4c-8g");

    for (const command of [
      "git ls-files .github/pr-assets",
      "node scripts/check-public-dependencies.ts",
      "vp install --frozen-lockfile",
      "vp run --filter @t3tools/desktop ensure:electron",
      "node scripts/validate-plugin-catalog.ts",
      "scripts/validate-plugin-catalog.test.ts",
      "scripts/plugin-contribution-policy.test.ts",
      "plugins/catalog.test.ts",
      "plugins/schema.test.ts",
      "plugins/lifecycle-matrix.test.ts",
      "vp run lint",
      "vp run fmt:check",
      "vp run typecheck",
      "vp run build:desktop",
      "apps/desktop/dist-electron/preload.cjs",
      "vp run build:marketing",
      "vp run --parallel --concurrency-limit 4",
      "cargo fmt --manifest-path native/resource-monitor/Cargo.toml -- --check",
      "cargo test --locked --manifest-path native/resource-monitor/Cargo.toml",
      "vp run release:smoke",
    ]) {
      expect(commands.some((candidate) => candidate.includes(command))).toBe(true);
    }

    expect(ci.jobs.check).not.toHaveProperty("strategy");
    const serverCommand =
      commands.find((command) => command.includes("vp run --filter akeru-bot test")) ?? "";
    expect(serverCommand).toContain("vp run --filter akeru-bot test");
    expect(serverCommand).toContain(
      "--exclude integration/orchestrationEngine.integration.test.ts",
    );
    expect(serverCommand).not.toContain("--shard");
  });

  it("coalesces version updates on a 4-vCPU runner", () => {
    const versionPackages = workflow(".github/workflows/version-packages.yml");
    const versionJob = versionPackages.jobs.version;

    expect(Object.keys(versionPackages.on)).toEqual(["push", "workflow_dispatch"]);
    expect(versionPackages.concurrency).toEqual({
      group: "version-packages",
      "cancel-in-progress": true,
    });
    expect(versionPackages.permissions).toEqual({
      actions: "write",
      contents: "write",
      "pull-requests": "write",
    });
    expect(versionJob?.["runs-on"]).toBe("tenki-standard-medium-4c-8g");
    expect(versionJob?.steps.find((step) => step.run)?.run).toBe("vp run release:version-pr");

    const updater = NodeFS.readFileSync(
      new URL("../scripts/update-version-pull-request.ts", import.meta.url),
      "utf8",
    );
    expect(updater).toContain('"merge-base",');
    expect(updater).toContain('"--is-ancestor",');
    expect(updater).toContain('"pr",\n    "edit",');
    expect(updater).toContain('"workflow", "run", "ci.yml"');
  });

  it("uses 4-vCPU Linux runners in the manual release smoke workflow", () => {
    const releaseSmoke = workflow(".github/workflows/release-smoke.yml");
    const text = NodeFS.readFileSync(
      new URL("../.github/workflows/release-smoke.yml", import.meta.url),
      "utf8",
    );

    expect(text).not.toContain("depot-");
    expect(text).toContain("tenki-standard-medium-4c-8g");
    expect(text).toContain("runner: macos-15");
    expect(text).toContain("windows-2025");
    expect(Object.keys(releaseSmoke.jobs).length).toBeGreaterThan(0);
  });

  it("skips stable release builds for non-version manifest pushes", () => {
    const text = NodeFS.readFileSync(
      new URL("../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );

    expect(text).toContain("printf 'publish=false\\n'");
    expect(text).toContain('git show "HEAD^:apps/server/package.json"');
    const unchangedVersion = text.indexOf('if test "$previous_version" = "$version"');
    const existingTag = text.indexOf('if git rev-parse --verify --quiet "refs/tags/v$version"');
    expect(unchangedVersion).toBeGreaterThan(-1);
    expect(existingTag).toBeGreaterThan(unchangedVersion);
    expect(text).toContain("if: steps.version.outputs.publish == 'true'");
    expect(text).toContain("if: needs.preflight.outputs.publish == 'true'");
    expect(text).toContain('if test "$EVENT_NAME" != workflow_dispatch');
    expect(text).toContain("gh workflow run version-packages.yml --ref main");
  });
});
