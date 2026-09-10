// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { layerTest as serverSettingsLayerTest } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { GrokDriver } from "./GrokDriver.ts";
import { GrokSkillsProbeError } from "./GrokSkills.ts";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const TestHttpClientLive = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

const BackgroundPolicyAlwaysRunLayer = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  reportHostPowerState: () => Effect.void,
  snapshot: Effect.succeed({
    hostPower: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: TEST_EPOCH,
    },
    leases: [],
    activeForegroundLeaseCount: 0,
    activeScopeKeys: [],
    shouldRunOpportunisticWork: true,
    updatedAt: TEST_EPOCH,
  }),
  streamChanges: Stream.empty,
  hasDemand: () => Effect.succeed(true),
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(true),
});

const grokDriverTestLayer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "akeru-grok-driver-test-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
  serverSettingsLayerTest(),
  TestHttpClientLive,
  Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
  BackgroundPolicyAlwaysRunLayer,
);

const LOGGED_IN_MODELS_OUTPUT = [
  "You are logged in with grok.com.",
  "",
  "Default model: grok-4.6",
  "",
  "Available models:",
  "  * grok-4.6 (default)",
  "",
].join("\n");

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const writeFakeGrokCli = (input: {
  readonly workspaceCwd: string;
  readonly inspect: "skills" | "fail";
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "akeru-grok-driver-cli-" });
    const modelsPath = path.join(dir, "models.txt");
    const machineSkillsPath = path.join(dir, "machine-skills.json");
    const workspaceSkillsPath = path.join(dir, "workspace-skills.json");
    const grokPath = path.join(dir, "grok");
    yield* fs.writeFileString(modelsPath, LOGGED_IN_MODELS_OUTPUT);
    yield* fs.writeFileString(
      machineSkillsPath,
      JSON.stringify({
        skills: [
          {
            name: "machine-skill",
            source: { type: "user", path: "/home/dev/.grok/skills/machine-skill/SKILL.md" },
          },
        ],
      }),
    );
    yield* fs.writeFileString(
      workspaceSkillsPath,
      JSON.stringify({
        skills: [
          {
            name: "project-skill",
            source: {
              type: "project",
              path: `${input.workspaceCwd}/.grok/skills/project-skill/SKILL.md`,
            },
          },
        ],
      }),
    );
    const inspectCase =
      input.inspect === "fail"
        ? "  inspect) exit 1;;"
        : [
            "  inspect)",
            `    if [ "$PWD" = ${shellQuote(input.workspaceCwd)} ]; then`,
            `      cat ${shellQuote(workspaceSkillsPath)}; exit 0`,
            "    fi",
            `    cat ${shellQuote(machineSkillsPath)}; exit 0;;`,
          ].join("\n");
    yield* fs.writeFileString(
      grokPath,
      [
        "#!/bin/sh",
        'case "$1" in',
        '  --version) printf "grok 1.0.13\\n"; exit 0;;',
        `  models) cat ${shellQuote(modelsPath)}; exit 0;;`,
        inspectCase,
        "  agent) exit 3;;",
        "esac",
        "exit 1",
        "",
      ].join("\n"),
    );
    yield* fs.chmod(grokPath, 0o755);
    return grokPath;
  });

const createGrokInstance = (input: { readonly enabled: boolean; readonly binaryPath: string }) =>
  GrokDriver.create({
    instanceId: ProviderInstanceId.make("grok"),
    displayName: undefined,
    environment: [],
    enabled: input.enabled,
    config: { ...GrokDriver.defaultConfig(), binaryPath: input.binaryPath },
  });

it.layer(grokDriverTestLayer)("GrokDriver.snapshotForCwd", (it) => {
  describe("workspace snapshots", () => {
    it.effect("skips inspect and returns the machine snapshot when Grok is disabled", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const workspaceCwd = yield* fs.makeTempDirectoryScoped({
            prefix: "akeru-grok-disabled-workspace-",
          });
          const grokPath = yield* writeFakeGrokCli({ workspaceCwd, inspect: "fail" });
          const instance = yield* createGrokInstance({ enabled: false, binaryPath: grokPath });
          expect(instance.snapshotForCwd).toBeTypeOf("function");

          const machine = yield* instance.snapshot.getSnapshot;
          const workspace = yield* instance.snapshotForCwd!(workspaceCwd);

          expect(workspace).toEqual(machine);
          expect(workspace.skills ?? []).toEqual([]);
        }),
      ),
    );

    it.effect("replaces machine skills with workspace inspect results", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const workspaceCwd = yield* fs.makeTempDirectoryScoped({
            prefix: "akeru-grok-workspace-",
          });
          const grokPath = yield* writeFakeGrokCli({ workspaceCwd, inspect: "skills" });
          const instance = yield* createGrokInstance({ enabled: true, binaryPath: grokPath });
          const machine = yield* instance.snapshot.refresh;
          const workspace = yield* instance.snapshotForCwd!(workspaceCwd);

          expect(machine.skills?.map((skill) => skill.name)).toEqual(["machine-skill"]);
          expect(workspace.skills).toEqual([
            {
              name: "project-skill",
              path: `${workspaceCwd}/.grok/skills/project-skill/SKILL.md`,
              scope: "project",
              enabled: true,
            },
          ]);
        }),
      ),
    );

    it.effect("propagates inspect failures as ProviderDriverError", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const workspaceCwd = yield* fs.makeTempDirectoryScoped({
            prefix: "akeru-grok-failed-workspace-",
          });
          const grokPath = yield* writeFakeGrokCli({ workspaceCwd, inspect: "fail" });
          const instance = yield* createGrokInstance({ enabled: true, binaryPath: grokPath });

          const machine = yield* instance.snapshot.refresh;
          expect(machine.skills ?? []).toEqual([]);

          const error = yield* instance.snapshotForCwd!(workspaceCwd).pipe(Effect.flip);
          expect(error._tag).toBe("ProviderDriverError");
          expect(error).toBeInstanceOf(ProviderDriverError);
          expect(error.detail).toContain(`Failed to discover Grok skills for '${workspaceCwd}'`);
          expect(error.cause).toBeInstanceOf(GrokSkillsProbeError);
          expect((error.cause as GrokSkillsProbeError).stage).toBe("exit");
        }),
      ),
    );
  });
});
