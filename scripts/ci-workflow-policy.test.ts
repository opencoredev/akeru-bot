// @effect-diagnostics nodeBuiltinImport:off - Tests inspect repository policy files.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";

type Step = {
  readonly name?: string;
  readonly id?: string;
  readonly if?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Readonly<Record<string, string | boolean>>;
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
    expect(ci.on.workflow_dispatch).toEqual({
      inputs: {
        expected_sha: {
          description: "Exact version-branch revision to validate",
          required: true,
          type: "string",
        },
        expected_pr_number: {
          description: "Repository-owned Changesets pull request to validate",
          required: true,
          type: "string",
        },
      },
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
    expect(ci.jobs.check?.steps.find((step) => step.name === "Checkout")?.with?.ref).toBe(
      "${{ inputs.expected_sha || github.sha }}",
    );
    const dispatchAuthorization = ci.jobs.check?.steps.find(
      (step) => step.name === "Authorize version-branch dispatch",
    );
    expect(dispatchAuthorization?.if).toBe("${{ github.event_name == 'workflow_dispatch' }}");
    expect(dispatchAuthorization?.run).toContain(".head.ref");
    expect(dispatchAuthorization?.run).toContain(".head.sha");
    expect(dispatchAuthorization?.run).toContain(".head.repo.full_name");
    expect(dispatchAuthorization?.run).toContain(".user.login");
    expect(dispatchAuthorization?.run).toContain("github-actions[bot]");
    expect(dispatchAuthorization?.run).toContain('test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"');

    const stableVersionGuard = ci.jobs.check?.steps.find(
      (step) => step.name === "Protect stable release versions",
    );
    const changesetGuard = ci.jobs.check?.steps.find(
      (step) => step.name === "Require a changeset decision",
    );
    for (const guard of [stableVersionGuard, changesetGuard]) {
      expect(guard?.if).toContain("github.head_ref == 'changeset-release/main'");
      expect(guard?.if).toContain(
        "github.event.pull_request.head.repo.full_name == github.repository",
      );
      expect(guard?.if).toContain("github.event.pull_request.user.login == 'github-actions[bot]'");
    }
    expect(stableVersionGuard?.run).toContain(
      "Only the repository-owned Changesets version PR may change release versions.",
    );
    expect(changesetGuard?.run).toContain("--diff-filter=A");
    expect(changesetGuard?.run).not.toContain("--diff-filter=ACMRT");

    for (const command of [
      "git ls-files .github/pr-assets",
      "node scripts/check-public-dependencies.ts",
      "vp install --frozen-lockfile",
      "vp exec changeset status --since=origin/main",
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
    expect(versionJob?.steps.some((step) => step.uses?.includes("changesets/action@"))).toBe(false);
    const version = versionJob?.steps.find((step) => step.id === "version");
    expect(version?.run).toContain("pnpm release:version");
    const changesets = versionJob?.steps.find((step) => step.id === "changesets");
    expect(changesets?.if).toBe("steps.version.outputs.changed == 'true'");
    // The PR lookup matches head.ref, since the pulls `head` filter misses this fork's PR.
    expect(changesets?.run).toContain(".head.ref == ");
    expect(changesets?.run).toContain("gh pr edit");
    expect(changesets?.run).not.toContain("gh release");
    const dispatch = versionJob?.steps.find(
      (step) => step.name === "Run checks for the updated version branch",
    );
    expect(dispatch?.if).toBe("steps.changesets.outputs.pullRequestNumber != ''");
    expect(dispatch?.if).not.toContain("hasChangesets");
    expect(dispatch?.run).toContain(".head.sha");
    expect(dispatch?.run).toContain(".head.repo.full_name");
    expect(dispatch?.run).toContain('test "$head_ref" = changeset-release/main');
    expect(dispatch?.run).toContain('-f expected_sha="$head_sha"');
    expect(dispatch?.run).toContain('-f expected_pr_number="$PR_NUMBER"');
  });

  it("uses 4-vCPU Linux runners in the manual release smoke workflow", () => {
    const releaseSmoke = workflow(".github/workflows/release-smoke.yml");
    const text = NodeFS.readFileSync(
      new URL("../.github/workflows/release-smoke.yml", import.meta.url),
      "utf8",
    );

    expect(text).not.toContain("depot-");
    expect(text).toContain("tenki-standard-medium-4c-8g");
    expect(text).toContain("runner: macos-26");
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

  it("fails stable but not nightly macOS releases when Apple credentials are absent", () => {
    const release = workflow(".github/workflows/release.yml");
    const steps = release.jobs.desktop?.steps ?? [];

    const validate = steps.find((step) => step.name === "Validate macOS signing credentials");
    expect(validate?.run).toContain("present != 0 && present != ${#values[@]}");
    expect(validate?.run).toContain(
      "Stable macOS releases require the complete Developer ID signing credential set.",
    );
    expect(validate?.run).toContain('test "$RELEASE_CHANNEL" = stable');
    expect(validate?.run).toMatch(/credential set\.\\n' >&2\n\s*exit 1/);
    expect(steps.find((step) => step.name === "Build signed macOS artifact")?.if).toBe(
      "matrix.platform == 'mac' && env.MACOS_SIGNED == 'true'",
    );
    expect(steps.find((step) => step.name === "Build unsigned macOS artifact")?.if).toBe(
      "matrix.platform == 'mac' && env.MACOS_SIGNED != 'true'",
    );
    expect(steps.find((step) => step.name === "Build unsigned macOS artifact")?.run).not.toContain(
      "--signed",
    );
    expect(steps.find((step) => step.name === "Notarize and verify macOS DMG")?.if).toBe(
      "matrix.platform == 'mac' && env.MACOS_SIGNED == 'true'",
    );
    expect(steps.find((step) => step.name === "Verify unsigned macOS app signature")?.if).toBe(
      "matrix.platform == 'mac' && env.MACOS_SIGNED != 'true'",
    );
    expect(
      steps.find((step) => step.name === "Verify unsigned macOS app signature")?.run,
    ).toContain("^Signature=adhoc$");
    expect(
      steps.find((step) => step.name === "Verify unsigned macOS app signature")?.run,
    ).toContain("grep -Fqx 'Identifier=dev.leodoes.akeru'");
  });

  it("publishes the Akeru Remote archives and signed manifest the installers download", () => {
    const release = workflow(".github/workflows/release.yml");
    const remote = release.jobs.remote as Job & {
      readonly strategy: {
        readonly matrix: { readonly include: ReadonlyArray<Record<string, string>> };
      };
    };
    expect(
      remote.strategy.matrix.include.map((entry) => [entry.runner, entry.platform, entry.arch]),
    ).toEqual([
      ["tenki-standard-medium-4c-8g", "linux", "x64"],
      ["macos-26", "darwin", "arm64"],
      ["windows-2025", "win32", "x64"],
    ]);
    const commands = remote.steps.flatMap((step) => (step.run ? [step.run] : []));
    expect(commands.join("\n")).not.toMatch(/docker/i);
    expect(commands).toContain(
      'node scripts/package-remote.ts archive "$RUNNER_TEMP/akeru-runtime" release "$RELEASE_VERSION" ${{ matrix.platform }} ${{ matrix.arch }}',
    );
    const upload = remote.steps.find((step) => step.uses === "actions/upload-artifact@v7");
    expect(upload?.with?.name).toBe(
      "${{ needs.preflight.outputs.channel }}-remote-${{ matrix.platform }}-${{ matrix.arch }}",
    );
    expect(upload?.with?.path).toBe("release/Akeru-Remote-*");

    const publish = release.jobs.release?.steps ?? [];
    const names = publish.map((step) => step.name);
    expect(names.indexOf("Sign the Akeru Remote manifest")).toBeGreaterThan(-1);
    expect(names.indexOf("Sign the Akeru Remote manifest")).toBeLessThan(
      names.indexOf("Verify names and hashes"),
    );
    expect(publish.find((step) => step.name === "Sign the Akeru Remote manifest")?.run).toBe(
      'node scripts/package-remote.ts manifest release "$RELEASE_VERSION"',
    );
  });
});
