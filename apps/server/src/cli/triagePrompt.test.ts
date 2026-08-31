// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  buildTriageContext,
  buildTriageLaunchPrompt,
  buildTriageSeedPrompt,
  TRIAGE_PLAYBOOK,
} from "./triagePrompt.ts";

const repoRoot = NodePath.join(import.meta.dirname, "../../../..");

it("stays byte-identical to .github/triage/PLAYBOOK.md", () => {
  // Old releases fetch the repo copy from `main` and follow it when it differs
  // from their bundled playbook. The two must say the same thing at HEAD, or a
  // playbook edit silently changes behavior only for old (or only for new)
  // installs. Edit both files together.
  const canonicalPath = NodePath.join(repoRoot, ".github/triage/PLAYBOOK.md");
  assert.equal(TRIAGE_PLAYBOOK, NodeFS.readFileSync(canonicalPath, "utf8"));
});

it("keeps the GitHub triage flow Akeru-only and labeled via-triage", () => {
  const issueTemplate = NodeFS.readFileSync(
    NodePath.join(repoRoot, ".github/ISSUE_TEMPLATE/via-triage.yml"),
    "utf8",
  );
  const bugTemplate = NodeFS.readFileSync(
    NodePath.join(repoRoot, ".github/ISSUE_TEMPLATE/bug_report.yml"),
    "utf8",
  );
  const issueLabelWorkflow = NodeFS.readFileSync(
    NodePath.join(repoRoot, ".github/workflows/issue-labels.yml"),
    "utf8",
  );
  const githubTriage = `${issueTemplate}\n${bugTemplate}`;

  assert.include(issueTemplate, "`npx akeru-bot triage`");
  assert.match(issueTemplate, /labels:\n  - via-triage\nbody:/u);
  assert.include(issueLabelWorkflow, 'name: "via-triage"');
  assert.notMatch(githubTriage, /T3 Code|npx t3|pingdotgg\/t3code|AI.generated/iu);
});

it("keeps the package identity and explicit approval gate", () => {
  const packageManifest = NodeFS.readFileSync(
    NodePath.join(repoRoot, "apps/server/package.json"),
    "utf8",
  );
  const triageSource = NodeFS.readFileSync(
    NodePath.join(repoRoot, "apps/server/src/cli/triage.ts"),
    "utf8",
  );

  assert.include(packageManifest, '"name": "akeru-bot"');
  assert.include(packageManifest, '"url": "https://github.com/opencoredev/akeru-bot"');
  assert.include(packageManifest, '"akeru": "./dist/bin.mjs"');
  assert.include(triageSource, 'Config.string("T3CODE_HOME")');
  assert.notInclude(triageSource, 'Config.string("AKERU_HOME")');
  assert.include(TRIAGE_PLAYBOOK, "Show the user the complete final issue text");
  assert.include(TRIAGE_PLAYBOOK, "get an explicit yes before");
  assert.include(TRIAGE_PLAYBOOK, "Never post without it");
  assert.include(TRIAGE_PLAYBOOK, "issues/new?template=via-triage.yml");
});

it("seed prompt names the context file and embeds the playbook", () => {
  const prompt = buildTriageSeedPrompt("/tmp/triage-run/context.md");
  assert.include(prompt, "/tmp/triage-run/context.md");
  assert.include(prompt, TRIAGE_PLAYBOOK);
});

it("launch prompt stays a single argv-safe line naming the prompt file", () => {
  // The launch argument goes through cmd.exe on Windows (.cmd shims), which
  // cannot carry newlines; the playbook itself must stay on disk.
  const launch = buildTriageLaunchPrompt(
    String.raw`C:\Users\a b\.akeru\userdata\triage\x\prompt.md`,
  );
  assert.notInclude(launch, "\n");
  assert.include(launch, String.raw`C:\Users\a b\.akeru\userdata\triage\x\prompt.md`);
  assert.isBelow(launch.length, 1_000);
});

it("context file carries every path the playbook depends on", () => {
  const context = buildTriageContext({
    generatedAt: "2026-08-13T00:00:00.000Z",
    version: "0.0.33",
    releaseTag: "v0.0.33",
    os: "linux x64 (7.0.0)",
    nodeVersion: "v24.0.0",
    launchedAs: "npx akeru-bot triage",
    server: "running (pid 42, http://127.0.0.1:4501)",
    paths: {
      stateDir: "/home/u/.akeru/userdata",
      dbPath: "/home/u/.akeru/userdata/state.sqlite",
      settingsPath: "/home/u/.akeru/userdata/settings.json",
      logsDir: "/home/u/.akeru/userdata/logs",
      serverLogPath: "/home/u/.akeru/userdata/logs/server.log",
      serverTracePath: "/home/u/.akeru/userdata/logs/server.trace.ndjson",
      providerEventLogPath: "/home/u/.akeru/userdata/logs/provider/events.log",
      terminalLogsDir: "/home/u/.akeru/userdata/logs/terminals",
      providerStatusCacheDir: "/home/u/.akeru/caches",
      secretsDir: "/home/u/.akeru/userdata/secrets",
      sourceCacheDir: "/home/u/.akeru/source",
    },
  });
  assert.include(context, "/home/u/.akeru/userdata/state.sqlite");
  assert.include(context, "/home/u/.akeru/userdata/logs/server.trace.ndjson");
  assert.include(context, "/home/u/.akeru/userdata/logs/provider/events.log");
  assert.include(context, "/home/u/.akeru/userdata/secrets");
  assert.include(context, "/home/u/.akeru/source");
  assert.include(context, "npx akeru-bot triage");
  assert.include(context, "v0.0.33");
});
