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
  readonly concurrency?: {
    readonly group?: string;
    readonly "cancel-in-progress"?: boolean;
  };
  readonly jobs: Record<string, Job>;
};

function workflow(path: string): Workflow {
  return parse(NodeFS.readFileSync(new URL(`../${path}`, import.meta.url), "utf8")) as Workflow;
}

describe("Depot workflow budget", () => {
  it("validates ready pull requests in one 4-vCPU job", () => {
    const ci = workflow(".depot/workflows/ci.yml");
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
    expect(ci.jobs.check?.["runs-on"]).toBe("depot-ubuntu-24.04-4");

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
    const versionPackages = workflow(".depot/workflows/version-packages.yml");
    const versionJob = versionPackages.jobs.version;

    expect(versionPackages.concurrency).toEqual({
      group: "version-packages",
      "cancel-in-progress": true,
    });
    expect(versionJob?.["runs-on"]).toBe("depot-ubuntu-24.04-4");
    expect(versionJob?.steps.find((step) => step.run)?.run).toContain(
      "vp run tegami version --no-checks",
    );
  });

  it("uses 4-vCPU Linux runners in the manual release smoke workflow", () => {
    const releaseSmoke = workflow(".depot/workflows/release-smoke.yml");
    const text = NodeFS.readFileSync(
      new URL("../.depot/workflows/release-smoke.yml", import.meta.url),
      "utf8",
    );

    expect(text).not.toContain("depot-ubuntu-24.04-8");
    expect(text).toContain("depot-ubuntu-24.04-4");
    expect(Object.keys(releaseSmoke.jobs).length).toBeGreaterThan(0);
  });
});
