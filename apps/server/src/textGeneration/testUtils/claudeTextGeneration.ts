import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings } from "@akeru/contracts";
import { isHostWindows } from "@akeru/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../../config.ts";
import * as TextGeneration from "../TextGeneration.ts";
import { layerWithSettings } from "../ClaudeTextGeneration.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const ClaudeTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-claude-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeFakeClaudeBinary(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const isWindows = yield* isHostWindows;
    const binDir = path.join(dir, "bin");
    const stubPath = path.join(binDir, "claude-stub.mjs");
    yield* fs.makeDirectory(binDir, { recursive: true });

    // The stub behaviour lives in Node rather than a `#!/bin/sh` script so the
    // same implementation is usable on Windows, where a shebang file is not
    // executable and would fall through to the real Claude CLI on PATH.
    yield* fs.writeFileString(
      stubPath,
      [
        "const argv = process.argv.slice(2);",
        'const args = argv.join(" ");',
        'const { realpathSync } = await import("node:fs");',
        "",
        "function fail(message, code) {",
        '  process.stderr.write(message + "\\n");',
        "  process.exit(code);",
        "}",
        "",
        'const permissionIndex = argv.indexOf("--permission-mode");',
        'if (permissionIndex === -1 || argv[permissionIndex + 1] !== "dontAsk") {',
        '  fail("text generation must deny permission prompts", 12);',
        "}",
        'const toolsIndex = argv.indexOf("--tools");',
        'if (toolsIndex === -1 || argv[toolsIndex + 1] !== "") {',
        '  fail("text generation must receive an explicit empty tool set", 6);',
        "}",
        'if (argv.includes("--dangerously-skip-permissions")) {',
        '  fail("text generation must not bypass permissions", 7);',
        "}",
        'if (!argv.includes("--disable-slash-commands")) {',
        '  fail("text generation must disable skills", 8);',
        "}",
        'if (!argv.includes("--strict-mcp-config")) {',
        '  fail("text generation must not load configured MCP servers", 9);',
        "}",
        'const settingsIndex = argv.indexOf("--settings");',
        "if (settingsIndex === -1 || JSON.parse(argv[settingsIndex + 1]).disableAllHooks !== true) {",
        '  fail("text generation must disable hooks", 10);',
        "}",
        "const cwdMustNotBe = process.env.T3_FAKE_CLAUDE_CWD_MUST_NOT_BE;",
        "if (cwdMustNotBe && realpathSync(process.cwd()) === realpathSync(cwdMustNotBe)) {",
        '  fail("text generation ran in the project directory", 11);',
        "}",
        "",
        'let stdinContent = "";',
        "if (!process.stdin.isTTY) {",
        "  const chunks = [];",
        "  for await (const chunk of process.stdin) {",
        "    chunks.push(chunk);",
        "  }",
        '  stdinContent = Buffer.concat(chunks).toString("utf8");',
        "}",
        "",
        "const argsMustContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;",
        "if (argsMustContain && !args.includes(argsMustContain)) {",
        '  fail("args missing expected content", 2);',
        "}",
        "",
        "const argsMustNotContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;",
        "if (argsMustNotContain && args.includes(argsMustNotContain)) {",
        '  fail("args contained forbidden content", 3);',
        "}",
        "",
        "const stdinMustContain = process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;",
        "if (stdinMustContain && !stdinContent.includes(stdinMustContain)) {",
        '  fail("stdin missing expected content", 4);',
        "}",
        "",
        "const configDirMustBe = process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE;",
        "if (configDirMustBe && process.env.CLAUDE_CONFIG_DIR !== configDirMustBe) {",
        '  fail("CLAUDE_CONFIG_DIR was " + (process.env.CLAUDE_CONFIG_DIR ?? ""), 5);',
        "}",
        "",
        "const stderrText = process.env.T3_FAKE_CLAUDE_STDERR;",
        "if (stderrText) {",
        '  process.stderr.write(stderrText + "\\n");',
        "}",
        "",
        'process.stdout.write(process.env.T3_FAKE_CLAUDE_OUTPUT ?? "");',
        "process.exitCode = Number(process.env.T3_FAKE_CLAUDE_EXIT_CODE ?? 0);",
        "",
      ].join("\n"),
    );

    if (isWindows) {
      // Windows resolves executables through PATHEXT, so the entry point has to
      // carry a real extension. `resolveSpawnCommand` spawns `.cmd` via a shell.
      yield* fs.writeFileString(
        path.join(binDir, "claude.cmd"),
        ["@echo off", 'node "%~dp0claude-stub.mjs" %*', "exit /b %ERRORLEVEL%", ""].join("\r\n"),
      );
    } else {
      const claudePath = path.join(binDir, "claude");
      yield* fs.writeFileString(
        claudePath,
        ["#!/bin/sh", 'exec node "$(dirname "$0")/claude-stub.mjs" "$@"', ""].join("\n"),
      );
      yield* fs.chmod(claudePath, 0o755);
    }

    return binDir;
  });
}

function withFakeClaudeEnv<A, E, R>(
  input: {
    output: string;
    exitCode?: number;
    stderr?: string;
    argsMustContain?: string;
    argsMustNotContain?: string;
    stdinMustContain?: string;
    configDirMustBe?: string;
    cwdMustNotBe?: string;
    claudeConfig?: Partial<ClaudeSettings>;
  },
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-claude-text-" });
    const binDir = yield* makeFakeClaudeBinary(tempDir);
    const pathDelimiter = (yield* isHostWindows) ? ";" : ":";
    const previousPath = process.env.PATH;
    const previousOutput = process.env.T3_FAKE_CLAUDE_OUTPUT;
    const previousExitCode = process.env.T3_FAKE_CLAUDE_EXIT_CODE;
    const previousStderr = process.env.T3_FAKE_CLAUDE_STDERR;
    const previousArgsMustContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
    const previousArgsMustNotContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
    const previousStdinMustContain = process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
    const previousConfigDirMustBe = process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE;
    const previousCwdMustNotBe = process.env.T3_FAKE_CLAUDE_CWD_MUST_NOT_BE;

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.env.PATH = `${binDir}${pathDelimiter}${previousPath ?? ""}`;
        process.env.T3_FAKE_CLAUDE_OUTPUT = input.output;

        if (input.exitCode !== undefined) {
          process.env.T3_FAKE_CLAUDE_EXIT_CODE = String(input.exitCode);
        } else {
          delete process.env.T3_FAKE_CLAUDE_EXIT_CODE;
        }

        if (input.stderr !== undefined) {
          process.env.T3_FAKE_CLAUDE_STDERR = input.stderr;
        } else {
          delete process.env.T3_FAKE_CLAUDE_STDERR;
        }

        if (input.argsMustContain !== undefined) {
          process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN = input.argsMustContain;
        } else {
          delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
        }

        if (input.argsMustNotContain !== undefined) {
          process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN = input.argsMustNotContain;
        } else {
          delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
        }

        if (input.stdinMustContain !== undefined) {
          process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN = input.stdinMustContain;
        } else {
          delete process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
        }

        if (input.configDirMustBe !== undefined) {
          process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE = input.configDirMustBe;
        } else {
          delete process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE;
        }

        if (input.cwdMustNotBe !== undefined) {
          process.env.T3_FAKE_CLAUDE_CWD_MUST_NOT_BE = input.cwdMustNotBe;
        } else {
          delete process.env.T3_FAKE_CLAUDE_CWD_MUST_NOT_BE;
        }
      }),
      () =>
        Effect.sync(() => {
          process.env.PATH = previousPath;

          if (previousOutput === undefined) {
            delete process.env.T3_FAKE_CLAUDE_OUTPUT;
          } else {
            process.env.T3_FAKE_CLAUDE_OUTPUT = previousOutput;
          }

          if (previousExitCode === undefined) {
            delete process.env.T3_FAKE_CLAUDE_EXIT_CODE;
          } else {
            process.env.T3_FAKE_CLAUDE_EXIT_CODE = previousExitCode;
          }

          if (previousStderr === undefined) {
            delete process.env.T3_FAKE_CLAUDE_STDERR;
          } else {
            process.env.T3_FAKE_CLAUDE_STDERR = previousStderr;
          }

          if (previousArgsMustContain === undefined) {
            delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
          } else {
            process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN = previousArgsMustContain;
          }

          if (previousArgsMustNotContain === undefined) {
            delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
          } else {
            process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN = previousArgsMustNotContain;
          }

          if (previousStdinMustContain === undefined) {
            delete process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
          } else {
            process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN = previousStdinMustContain;
          }

          if (previousConfigDirMustBe === undefined) {
            delete process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE;
          } else {
            process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE = previousConfigDirMustBe;
          }

          if (previousCwdMustNotBe === undefined) {
            delete process.env.T3_FAKE_CLAUDE_CWD_MUST_NOT_BE;
          } else {
            process.env.T3_FAKE_CLAUDE_CWD_MUST_NOT_BE = previousCwdMustNotBe;
          }
        }),
    );

    const config = decodeClaudeSettings(input.claudeConfig ?? {});

    return yield* Effect.flatMap(TextGeneration.TextGeneration, effectFn).pipe(
      Effect.provide(layerWithSettings(config)),
    );
  }).pipe(Effect.scoped);
}

export {
  decodeClaudeSettings,
  ClaudeTextGenerationTestLayer,
  makeFakeClaudeBinary,
  withFakeClaudeEnv,
};
