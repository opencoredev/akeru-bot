import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  type Options as ClaudeQueryOptions,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { ProviderInstanceId, ThreadId } from "@akeru/contracts";
import { HostProcessPlatform } from "@akeru/shared/hostProcess";
import { SpawnExecutableResolution } from "@akeru/shared/shell";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ClaudeExecutableFileCheck } from "../Drivers/ClaudeExecutable.ts";
import { createClaudeCodeQuery } from "../Layers/claude/ClaudeCodeProcess.ts";
import {
  CLAUDE_CODE_INSTANCE_ID,
  claudeCodeTestLayer,
  makeClaudeCodeAdapter,
  silentProcess,
} from "../Layers/test-support/claudeCodeAdapterHarness.ts";
import { CLAUDE_CODE_DRIVER_KIND, probeClaudeCodeLogin } from "./ClaudeCodeLogin.ts";
import {
  claudeCodeAdapterOptions,
  claudeCodeAssignedConfigDirectory,
  claudeCodeInstanceEnvironment,
} from "./ClaudeCodeSession.ts";

/**
 * A Claude Code config folder that tries every way settings could undo the
 * login or escape the policy: an `env` key, an `apiKeyHelper`, and a
 * SessionStart command hook. The helper and hook leave marker files.
 */
function writeHostileClaudeHome() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-hostile-claude-"));
  const home = NodePath.join(root, "home");
  const configDirectory = NodePath.join(root, "config");
  NodeFS.mkdirSync(home);
  NodeFS.mkdirSync(configDirectory);

  const settings = {
    env: { ANTHROPIC_API_KEY: "sk-ant-api-from-settings" },
    apiKeyHelper: `touch ${NodePath.join(root, "helper-ran")}; echo sk-ant-api-from-helper`,
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: `touch ${NodePath.join(root, "hook-ran")}` }] },
      ],
    },
  };

  NodeFS.writeFileSync(NodePath.join(configDirectory, "settings.json"), JSON.stringify(settings));
  NodeFS.writeFileSync(NodePath.join(home, ".claude.json"), "{}");

  return {
    root,
    home,
    configDirectory,
    helperRan: () => NodeFS.existsSync(NodePath.join(root, "helper-ran")),
    hookRan: () => NodeFS.existsSync(NodePath.join(root, "hook-ran")),
  };
}

/** The installed `claude`, found on PATH without starting it. */
const installedClaude = Option.fromNullishOr(
  (process.env.PATH ?? "")
    .split(NodePath.delimiter)
    .map((directory) => NodePath.join(directory, "claude"))
    .find((candidate) => {
      try {
        NodeFS.accessSync(candidate, NodeFS.constants.X_OK);

        return true;
      } catch {
        return false;
      }
    }),
);

describe("Claude Code login settings isolation", () => {
  it.effect("starts sessions with no settings files and no settings hooks", () =>
    Effect.gen(function* () {
      const spawned: SpawnOptions[] = [];
      let options: ClaudeQueryOptions | undefined;

      const adapter = yield* makeClaudeCodeAdapter((input) => {
        options = input.options;

        return createClaudeCodeQuery({
          ...input,
          spawnProcess: (spawnOptions) => {
            spawned.push(spawnOptions);

            return silentProcess();
          },
        });
      });

      const threadId = ThreadId.make("thread-claude-code-isolation");
      yield* adapter.startSession({
        threadId,
        provider: CLAUDE_CODE_DRIVER_KIND,
        runtimeMode: "approval-required",
      });

      assert.deepEqual(options?.settingSources, []);
      assert.deepInclude(options?.settings, { disableAllHooks: true });
      assert.include(spawned[0]?.args ?? [], "--setting-sources=");
      assert.include(JSON.stringify(spawned[0]?.args ?? []), "disableAllHooks");

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(claudeCodeTestLayer)),
  );

  // Runs the installed Claude Code against a throwaway home, so no real login is
  // read. It shows the hostile settings would win if Akeru loaded them.
  it.effect.skipIf(Option.isNone(installedClaude))(
    "ignores env, apiKeyHelper, and hooks from a hostile settings folder",
    () =>
      Effect.gen(function* () {
        const hostile = writeHostileClaudeHome();

        const environment = {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: hostile.home,
          CLAUDE_CONFIG_DIR: hostile.configDirectory,
        };

        const state = yield* probeClaudeCodeLogin(Option.getOrThrow(installedClaude), environment);

        assert.equal(state.kind, "logged-out");
        assert.isFalse(hostile.helperRan());
        assert.isFalse(hostile.hookRan());
      }).pipe(Effect.provide(NodeServices.layer)),
    60_000,
  );
});

describe("Claude Code login environment on Windows", () => {
  it.effect("reads an account's lower-case AKERU_CLAUDE_PATH over the inherited one", () =>
    Effect.gen(function* () {
      const result = yield* claudeCodeInstanceEnvironment(
        { binaryPath: "", homePath: "" },
        [{ name: "akeru_claude_path", value: "D:\\tools\\claude.exe", sensitive: false }],
        { AKERU_CLAUDE_PATH: "C:\\old\\claude.exe", Path: "C:\\Windows" },
      );

      assert.equal(result.command, "D:\\tools\\claude.exe");
      assert.equal(result.executable, "D:\\tools\\claude.exe");
    }).pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("keeps an account's sensitive lower-case AKERU_CLAUDE_PATH off the snapshot", () =>
    Effect.gen(function* () {
      const result = yield* claudeCodeInstanceEnvironment(
        { binaryPath: "", homePath: "" },
        [{ name: "akeru_claude_path", value: "D:\\private\\claude.exe", sensitive: true }],
        { AKERU_CLAUDE_PATH: "C:\\old\\claude.exe", Path: "C:\\Windows" },
      );

      assert.equal(result.command, "D:\\private\\claude.exe");
      assert.equal(result.executable, undefined);
    }).pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("keeps one spelling per variable, the account's last row winning", () =>
    Effect.gen(function* () {
      const result = yield* claudeCodeInstanceEnvironment(
        { binaryPath: "claude", homePath: "" },
        [
          { name: "USERPROFILE", value: "D:\\first", sensitive: false },
          { name: "UserProfile", value: "E:\\second", sensitive: false },
        ],
        { USERPROFILE: "C:\\Users\\server", Path: "C:\\Windows" },
      );

      const names = Object.keys(result.environment).filter(
        (name) => name.toUpperCase() === "USERPROFILE",
      );

      // The login card reads the last row too, so both sides use E:\second.
      assert.deepEqual(names, ["USERPROFILE"]);
      assert.equal(result.environment.USERPROFILE, "E:\\second");
    }).pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provide(NodeServices.layer),
    ),
  );
});

describe("Claude Code login environment", () => {
  it.effect("keeps only the account's own CLAUDE_CONFIG_DIR", () =>
    Effect.gen(function* () {
      const inherited = { PATH: "/usr/bin", HOME: "/home/me", CLAUDE_CONFIG_DIR: "/home/me/.x" };

      const fromVariable = yield* claudeCodeInstanceEnvironment(
        { binaryPath: "claude", homePath: "" },
        [{ name: "CLAUDE_CONFIG_DIR", value: "/home/me/.claude-work", sensitive: false }],
        inherited,
      );

      assert.equal(fromVariable.environment.CLAUDE_CONFIG_DIR, "/home/me/.claude-work");

      const fromPath = yield* claudeCodeInstanceEnvironment(
        { binaryPath: "claude", homePath: "/srv/claude-second" },
        undefined,
        inherited,
      );

      assert.equal(fromPath.environment.CLAUDE_CONFIG_DIR, "/srv/claude-second");

      const none = yield* claudeCodeInstanceEnvironment(
        { binaryPath: "claude", homePath: "" },
        undefined,
        inherited,
      );

      assert.notProperty(none.environment, "CLAUDE_CONFIG_DIR");

      // A relative or ~ folder is read from the user's home, never the server's folder.
      const relativeVariable = yield* claudeCodeInstanceEnvironment(
        { binaryPath: "claude", homePath: "" },
        [{ name: "CLAUDE_CONFIG_DIR", value: "claude-work", sensitive: false }],
        inherited,
      );

      assert.equal(relativeVariable.configDirectory, "/home/me/claude-work");
      assert.equal(relativeVariable.environment.CLAUDE_CONFIG_DIR, "/home/me/claude-work");

      const relativePath = yield* claudeCodeInstanceEnvironment(
        { binaryPath: "claude", homePath: "./second" },
        undefined,
        inherited,
      );

      assert.equal(relativePath.environment.CLAUDE_CONFIG_DIR, "/home/me/second");

      const tildePath = yield* claudeCodeInstanceEnvironment(
        { binaryPath: "claude", homePath: "~/.claude-alt" },
        undefined,
        inherited,
      );

      assert.equal(tildePath.environment.CLAUDE_CONFIG_DIR, "/home/me/.claude-alt");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses the assigned folder only when the account names none", () =>
    Effect.gen(function* () {
      const inherited = { PATH: "/usr/bin", HOME: "/home/me", CLAUDE_CONFIG_DIR: "/home/me/.x" };
      const assigned = "/state/providers/claude-code/claudeCode_work";

      const fallback = yield* claudeCodeInstanceEnvironment(
        { binaryPath: "claude", homePath: "" },
        undefined,
        inherited,
        assigned,
      );

      assert.equal(fallback.environment.CLAUDE_CONFIG_DIR, assigned);
      assert.equal(fallback.publishedConfigDirectory, assigned);

      const own = yield* claudeCodeInstanceEnvironment(
        { binaryPath: "claude", homePath: "~/.claude-work" },
        undefined,
        inherited,
        assigned,
      );

      assert.equal(own.environment.CLAUDE_CONFIG_DIR, "/home/me/.claude-work");
      assert.equal(own.publishedConfigDirectory, "/home/me/.claude-work");

      const sensitive = yield* claudeCodeInstanceEnvironment(
        { binaryPath: "claude", homePath: "" },
        [{ name: "CLAUDE_CONFIG_DIR", value: "/secret/claude", sensitive: true }],
        inherited,
        assigned,
      );

      assert.equal(sensitive.environment.CLAUDE_CONFIG_DIR, "/secret/claude");
      assert.isUndefined(sensitive.publishedConfigDirectory);

      const original = yield* claudeCodeAssignedConfigDirectory(CLAUDE_CODE_INSTANCE_ID, "/state");

      const work = yield* claudeCodeAssignedConfigDirectory(
        ProviderInstanceId.make("claudeCode_work"),
        "/state",
      );

      assert.isUndefined(original);
      assert.equal(work, assigned);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("publishes the program it runs, but not a sensitive path variable", () =>
    Effect.gen(function* () {
      const inherited = { PATH: "/usr/bin", HOME: "/home/me", AKERU_CLAUDE_PATH: "/opt/claude" };

      const fromServer = yield* claudeCodeInstanceEnvironment(
        { binaryPath: "claude", homePath: "" },
        undefined,
        inherited,
      );

      assert.equal(fromServer.command, "/opt/claude");
      assert.equal(fromServer.executable, "/opt/claude");

      const sensitive = yield* claudeCodeInstanceEnvironment(
        { binaryPath: "claude", homePath: "" },
        [{ name: "AKERU_CLAUDE_PATH", value: "/secret/claude", sensitive: true }],
        inherited,
      );

      assert.equal(sensitive.command, "/secret/claude");
      assert.isUndefined(sensitive.executable);

      const fromPath = yield* claudeCodeInstanceEnvironment(
        { binaryPath: "claude", homePath: "" },
        undefined,
        { PATH: "/usr/bin", HOME: "/home/me" },
      );

      assert.equal(fromPath.command, "claude");
      assert.isUndefined(fromPath.executable);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("follows a Windows claude.cmd shim to the packaged binary", () =>
    Effect.gen(function* () {
      const npmDirectory = "C:\\Users\\dev\\AppData\\Roaming\\npm";
      const shim = `${npmDirectory}\\claude.cmd`;
      const packaged = `${npmDirectory}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;

      const { options } = yield* claudeCodeAdapterOptions({
        instanceId: CLAUDE_CODE_INSTANCE_ID,
        command: "claude",
        loginEnvironment: { PATH: npmDirectory, PATHEXT: ".EXE;.CMD" },
      });

      const resolved = yield* options.resolveExecutablePath.pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provideService(SpawnExecutableResolution, () => shim),
        Effect.provideService(ClaudeExecutableFileCheck, (filePath) =>
          Effect.succeed(filePath === packaged),
        ),
      );

      assert.equal(resolved, packaged);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
