import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as TestClock from "effect/testing/TestClock";
import {
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";

import { OpenCodeRuntime, OpenCodeRuntimeLive } from "./opencodeRuntime.ts";

const testLayer = OpenCodeRuntimeLive.pipe(Layer.provideMerge(NodeServices.layer));

class OpenCodeCommandStillAliveError extends Data.TaggedError("OpenCodeCommandStillAliveError") {}

it.layer(testLayer)("OpenCodeRuntime inventory", (it) => {
  it.effect("keeps provider inventory when skill discovery fails", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const client = {
        provider: {
          list: () =>
            Promise.resolve({
              data: {
                connected: ["openai"],
                all: [],
                default: {},
              },
            }),
        },
        app: {
          agents: () => Promise.resolve({ data: [] }),
          skills: () => Promise.reject(new Error("skills endpoint unavailable")),
        },
      } as unknown as OpencodeClient;

      const inventory = yield* runtime.loadOpenCodeInventory(client);

      NodeAssert.deepEqual(inventory.providerList.connected, ["openai"]);
      NodeAssert.deepEqual(inventory.agents, []);
      NodeAssert.deepEqual(inventory.skills, []);
    }),
  );

  it.effect("keeps only SDK skill metadata in inventory", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const client = {
        provider: {
          list: () =>
            Promise.resolve({
              data: {
                connected: ["openai"],
                all: [],
                default: {},
              },
            }),
        },
        app: {
          agents: () => Promise.resolve({ data: [] }),
          skills: () =>
            Promise.resolve({
              data: [
                {
                  name: "review",
                  description: "Review code changes",
                  location: "/skills/review/SKILL.md",
                  content: "unused skill content",
                },
              ],
            }),
        },
      } as unknown as OpencodeClient;

      const inventory = yield* runtime.loadOpenCodeInventory(client);

      NodeAssert.deepEqual(inventory.skills, [
        {
          name: "review",
          description: "Review code changes",
          location: "/skills/review/SKILL.md",
        },
      ]);
    }),
  );

  it.effect("drops oversized CLI skill output without losing the model inventory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const hostEnvironment = yield* HostProcessEnvironment;
      const executablePath = yield* HostProcessExecutablePath;
      const hostPlatform = yield* HostProcessPlatform;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-inventory-" });
      const isWindows = hostPlatform === "win32";
      const binaryPath = path.join(tempDir, isWindows ? "opencode.cmd" : "opencode");
      const scriptPath = path.join(tempDir, "opencode.mjs");
      const oversizedContentBytes = 8 * 1024 * 1024 + 1;

      yield* fs.writeFileString(
        scriptPath,
        [
          'if (process.argv[2] === "models") {',
          '  process.stdout.write(`openai/gpt-test\\n{"id":"gpt-test","providerID":"openai","name":"GPT Test"}\\n`);',
          '} else if (process.argv[2] === "debug") {',
          `  const content = "x".repeat(${oversizedContentBytes});`,
          '  process.stdout.write(`[{"name":"oversized","content":"${content}"}]`);',
          "}",
          "",
        ].join("\n"),
      );
      yield* fs.writeFileString(
        binaryPath,
        [
          ...(isWindows ? ["@echo off"] : ["#!/bin/sh"]),
          isWindows
            ? '"%T3_TEST_NODE_BINARY%" "%T3_TEST_OPENCODE_SCRIPT%" %*'
            : 'exec "$T3_TEST_NODE_BINARY" "$T3_TEST_OPENCODE_SCRIPT" "$@"',
          "",
        ].join("\n"),
      );
      if (!isWindows) {
        yield* fs.chmod(binaryPath, 0o755);
      }

      const runtime = yield* OpenCodeRuntime;
      const inventory = yield* runtime.loadInventoryFromCli({
        binaryPath,
        cwd: tempDir,
        environment: {
          ...hostEnvironment,
          T3_TEST_NODE_BINARY: executablePath,
          T3_TEST_OPENCODE_SCRIPT: scriptPath,
        },
      });

      NodeAssert.deepEqual(inventory.providerList.connected, ["openai"]);
      NodeAssert.equal(inventory.skills.length, 0);
    }),
  );

  it.effect("caps and drains command stdout and stderr when requested", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const executablePath = yield* HostProcessExecutablePath;
      const outputBytes = 2 * 1024 * 1024;
      const result = yield* runtime.runOpenCodeCommand({
        binaryPath: executablePath,
        args: [
          "-e",
          `process.stdout.write("o".repeat(${outputBytes})); process.stderr.write("e".repeat(${outputBytes}));`,
        ],
        maxOutputBytes: 64,
      });

      NodeAssert.equal(result.stdout, "o".repeat(64));
      NodeAssert.equal(result.stderr, "e".repeat(64));
      NodeAssert.equal(result.code, 0);
    }),
  );

  it.effect("runs inventory CLI commands one at a time", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const hostEnvironment = yield* HostProcessEnvironment;
      const executablePath = yield* HostProcessExecutablePath;
      const hostPlatform = yield* HostProcessPlatform;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-serial-" });
      const isWindows = hostPlatform === "win32";
      const binaryPath = path.join(tempDir, isWindows ? "opencode.cmd" : "opencode");
      const scriptPath = path.join(tempDir, "opencode.mjs");
      const lockPath = path.join(tempDir, "lock");
      const overlapPath = path.join(tempDir, "overlap");
      const logPath = path.join(tempDir, "log");

      yield* fs.writeFileString(
        scriptPath,
        [
          'import * as fs from "node:fs";',
          'const command = process.argv[2] ?? "unknown";',
          "const lock = process.env.T3_TEST_OPENCODE_LOCK;",
          "const overlap = process.env.T3_TEST_OPENCODE_OVERLAP;",
          "const log = process.env.T3_TEST_OPENCODE_LOG;",
          "if (lock && overlap && fs.existsSync(lock)) fs.writeFileSync(overlap, command);",
          "if (lock) fs.writeFileSync(lock, command);",
          "if (log) fs.appendFileSync(log, `${command}\\n`);",
          "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);",
          "if (lock) fs.unlinkSync(lock);",
          'if (command === "models") {',
          '  process.stdout.write(`openai/gpt-test\\n{"id":"gpt-test","providerID":"openai","name":"GPT Test"}\\n`);',
          '} else if (command === "agent") {',
          '  process.stdout.write("[]\\n");',
          "} else {",
          '  process.stdout.write("[]\\n");',
          "}",
          "",
        ].join("\n"),
      );
      yield* fs.writeFileString(
        binaryPath,
        [
          ...(isWindows ? ["@echo off"] : ["#!/bin/sh"]),
          isWindows
            ? '"%T3_TEST_NODE_BINARY%" "%T3_TEST_OPENCODE_SCRIPT%" %*'
            : 'exec "$T3_TEST_NODE_BINARY" "$T3_TEST_OPENCODE_SCRIPT" "$@"',
          "",
        ].join("\n"),
      );
      if (!isWindows) {
        yield* fs.chmod(binaryPath, 0o755);
      }

      const runtime = yield* OpenCodeRuntime;
      const inventory = yield* runtime.loadInventoryFromCli({
        binaryPath,
        cwd: tempDir,
        environment: {
          ...hostEnvironment,
          T3_TEST_NODE_BINARY: executablePath,
          T3_TEST_OPENCODE_SCRIPT: scriptPath,
          T3_TEST_OPENCODE_LOCK: lockPath,
          T3_TEST_OPENCODE_OVERLAP: overlapPath,
          T3_TEST_OPENCODE_LOG: logPath,
        },
      });

      NodeAssert.deepEqual(inventory.providerList.connected, ["openai"]);
      const overlapExists = yield* fs.exists(overlapPath);
      NodeAssert.equal(overlapExists, false);
      const log = yield* fs.readFileString(logPath);
      NodeAssert.equal(log.trim(), ["models", "agent", "debug"].join("\n"));
    }),
  );

  it.effect("kills a hanging command process group when the command is interrupted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const hostEnvironment = yield* HostProcessEnvironment;
      const executablePath = yield* HostProcessExecutablePath;
      const hostPlatform = yield* HostProcessPlatform;
      if (hostPlatform === "win32") {
        return;
      }

      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-hang-" });
      const binaryPath = path.join(tempDir, "opencode");
      const scriptPath = path.join(tempDir, "opencode.mjs");
      const pidPath = path.join(tempDir, "pid");

      yield* fs.writeFileString(
        scriptPath,
        [
          'import * as fs from "node:fs";',
          "fs.writeFileSync(process.env.T3_TEST_OPENCODE_PID, String(process.pid));",
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
      );
      yield* fs.writeFileString(
        binaryPath,
        ["#!/bin/sh", 'exec "$T3_TEST_NODE_BINARY" "$T3_TEST_OPENCODE_SCRIPT" "$@"', ""].join("\n"),
      );
      yield* fs.chmod(binaryPath, 0o755);

      const runtime = yield* OpenCodeRuntime;
      const commandFiber = yield* runtime
        .runOpenCodeCommand({
          binaryPath,
          args: ["--version"],
          environment: {
            ...hostEnvironment,
            T3_TEST_NODE_BINARY: executablePath,
            T3_TEST_OPENCODE_SCRIPT: scriptPath,
            T3_TEST_OPENCODE_PID: pidPath,
          },
        })
        .pipe(Effect.forkChild);

      const pidText = yield* fs
        .readFileString(pidPath)
        .pipe(Effect.retry(Schedule.spaced("25 millis")), Effect.timeoutOption("2 seconds"));
      if (Option.isNone(pidText)) {
        yield* Fiber.interrupt(commandFiber);
        NodeAssert.fail("Hanging OpenCode command never wrote its pid.");
      }
      const pid = Number(pidText.value.trim());
      NodeAssert.ok(Number.isInteger(pid) && pid > 0);

      yield* Fiber.interrupt(commandFiber);

      const stillAlive = yield* Effect.sync(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      }).pipe(
        Effect.filterOrFail(
          (alive) => !alive,
          () => new OpenCodeCommandStillAliveError(),
        ),
        Effect.retry(Schedule.spaced("25 millis")),
        Effect.timeoutOption("2 seconds"),
      );
      NodeAssert.equal(Option.isSome(stillAlive), true);
    }).pipe(TestClock.withLive),
  );
});
