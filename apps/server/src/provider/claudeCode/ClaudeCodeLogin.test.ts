import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  CLAUDE_CODE_PATH_ENV,
  claudeCodeCommand,
  claudeCodeLoginEnvironment,
  claudeCodeProviderDraft,
  probeClaudeCodeLogin,
} from "./ClaudeCodeLogin.ts";

const LOGGED_OUT_ACCOUNT = { tokenSource: "none", apiProvider: "firstParty" };

const READY_ACCOUNT = {
  tokenSource: "claude.ai",
  apiProvider: "firstParty",
  email: "owner@example.com",
  subscriptionType: "max",
};

/**
 * A stand-in for the `claude` program, run by the real Claude Agent SDK. It
 * answers `--version`, then the SDK's initialize handshake with the given
 * account, the way Claude Code does. Each start appends its arguments and
 * environment next to it.
 */
function writeFakeClaude(input: {
  readonly version?: { readonly stdout: string; readonly code: number };
  /** The account the handshake reports, or `exit` to quit before answering. */
  readonly account: object | "exit";
}) {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-fake-claude-"));
  const executable = NodePath.join(directory, "claude");
  const startsFile = NodePath.join(directory, "starts.jsonl");
  const version = input.version ?? { stdout: "2.1.316 (Claude Code)", code: 0 };

  NodeFS.writeFileSync(
    executable,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'const readline = require("node:readline");',
      `fs.appendFileSync(${JSON.stringify(startsFile)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }) + "\\n");`,
      'if (process.argv.includes("--version")) {',
      `  console.log(${JSON.stringify(version.stdout)});`,
      `  process.exit(${version.code});`,
      "}",
      `const account = ${JSON.stringify(input.account)};`,
      'if (account === "exit") process.exit(1);',
      'readline.createInterface({ input: process.stdin }).on("line", (line) => {',
      "  const message = JSON.parse(line);",
      '  if (message.type !== "control_request" || message.request.subtype !== "initialize") return;',
      '  const response = { commands: [], agents: [], output_style: "default", available_output_styles: [], models: [], account };',
      '  process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response } }) + "\\n");',
      "});",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const starts = () =>
    NodeFS.readFileSync(startsFile, "utf8")
      .trim()
      .split("\n")
      .map((line): { argv: string[]; env: Record<string, string> } => JSON.parse(line));

  return { executable, starts };
}

const environmentFor = (executable: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  [CLAUDE_CODE_PATH_ENV]: executable,
});

const DEFAULT_SETTINGS = { binaryPath: "claude", customModels: [], enabled: true };

describe("probeClaudeCodeLogin", () => {
  it.effect("reports not installed when the program cannot be found", () =>
    Effect.gen(function* () {
      const state = yield* probeClaudeCodeLogin("/nonexistent-akeru-path/claude", {
        PATH: "/nonexistent-akeru-path",
      });

      assert.equal(state.kind, "not-installed");

      const draft = yield* claudeCodeProviderDraft(DEFAULT_SETTINGS, state);
      assert.equal(draft.installed, false);
      assert.equal(draft.status, "error");
      assert.include(draft.message ?? "", "not installed");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports logged out when Claude Code has no login", () =>
    Effect.gen(function* () {
      const fake = writeFakeClaude({ account: LOGGED_OUT_ACCOUNT });
      const state = yield* probeClaudeCodeLogin(fake.executable, environmentFor(fake.executable));

      assert.equal(state.kind, "logged-out");

      const draft = yield* claudeCodeProviderDraft(DEFAULT_SETTINGS, state);
      assert.equal(draft.installed, true);
      assert.equal(draft.version, "2.1.316");
      assert.equal(draft.auth.status, "unauthenticated");
      assert.equal(draft.unavailability, "missing-login");
      assert.include(draft.message ?? "", "claude auth login");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports ready with the login Claude Code describes", () =>
    Effect.gen(function* () {
      const fake = writeFakeClaude({ account: READY_ACCOUNT });
      const state = yield* probeClaudeCodeLogin(fake.executable, environmentFor(fake.executable));

      assert.equal(state.kind, "ready");

      const draft = yield* claudeCodeProviderDraft(DEFAULT_SETTINGS, state);
      assert.equal(draft.status, "ready");
      assert.equal(draft.auth.status, "authenticated");
      assert.equal(draft.auth.label, "Claude Max Subscription");
      assert.equal(draft.auth.email, "owner@example.com");
      assert.isUndefined(draft.message);
      assert.isTrue(draft.models.some((model) => model.slug === "claude-opus-5-5"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports an error when Claude Code does not start", () =>
    Effect.gen(function* () {
      const fake = writeFakeClaude({
        version: { stdout: "boom", code: 1 },
        account: READY_ACCOUNT,
      });

      const state = yield* probeClaudeCodeLogin(fake.executable, environmentFor(fake.executable));

      assert.equal(state.kind, "error");

      const draft = yield* claudeCodeProviderDraft(DEFAULT_SETTINGS, state);
      assert.equal(draft.status, "error");
      assert.equal(draft.installed, true);
      assert.include(draft.message ?? "", "did not start");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports an error when Claude Code cannot start a session", () =>
    Effect.gen(function* () {
      const fake = writeFakeClaude({ account: "exit" });
      const state = yield* probeClaudeCodeLogin(fake.executable, environmentFor(fake.executable));

      assert.equal(state.kind, "error");
      assert.include(state.kind === "error" ? state.message : "", "claude update");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("checks the login with every settings file and hook turned off", () =>
    Effect.gen(function* () {
      const fake = writeFakeClaude({ account: READY_ACCOUNT });
      yield* probeClaudeCodeLogin(fake.executable, environmentFor(fake.executable));

      const session = fake.starts().find((start) => !start.argv.includes("--version"));
      assert.include(session?.argv ?? [], "--setting-sources=");
      assert.include(JSON.stringify(session?.argv ?? []), "disableAllHooks");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("never hands Claude Code a token or API key", () =>
    Effect.gen(function* () {
      const fake = writeFakeClaude({ account: READY_ACCOUNT });

      yield* probeClaudeCodeLogin(
        fake.executable,
        claudeCodeLoginEnvironment({
          ...environmentFor(fake.executable),
          CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-should-not-pass",
          ANTHROPIC_API_KEY: "sk-ant-api-should-not-pass",
          ANTHROPIC_BASE_URL: "https://gateway.example.com",
          ANTHROPIC_CUSTOM_HEADERS: "x-claude-code: impersonate",
          CLAUDE_CODE_USE_BEDROCK: "1",
          AWS_SECRET_ACCESS_KEY: "secret",
        }),
      );

      const spawnedEnvironment = fake
        .starts()
        .map((start) => Object.keys(start.env).join("\n"))
        .join("\n");

      for (const key of [
        "CLAUDE_CODE_OAUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_CUSTOM_HEADERS",
        "CLAUDE_CODE_USE_BEDROCK",
        "AWS_SECRET_ACCESS_KEY",
      ]) {
        assert.notInclude(spawnedEnvironment, key);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("claudeCodeCommand", () => {
  it("prefers the instance path, then AKERU_CLAUDE_PATH, then claude on PATH", () => {
    const env = { [CLAUDE_CODE_PATH_ENV]: "/opt/claude/bin/claude" };

    assert.equal(claudeCodeCommand({ binaryPath: "/custom/claude" }, env), "/custom/claude");
    assert.equal(claudeCodeCommand({ binaryPath: "claude" }, env), "/opt/claude/bin/claude");
    assert.equal(claudeCodeCommand({ binaryPath: "" }, {}), "claude");
  });
});
