import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type EnvironmentHostProfile,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ServerSettingsError,
} from "@akeru/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  type CpuTimes,
  type EnvironmentHostMachine,
  cpuUtilizationBetween,
  isProviderReady,
  make,
  allowedCpuIds,
  procStatCpuTimes,
  memAvailableBytes,
} from "./EnvironmentHost.ts";
import { detectEnvironmentHostTools, splitSearchPath } from "./EnvironmentHostTools.ts";
import { ServerEnvironment } from "./ServerEnvironment.ts";

const GIB = 1024 ** 3;

const existsIn = (paths: ReadonlyArray<string>) => {
  const present = new Set(paths);
  const checked: string[] = [];

  return {
    checked,
    exists: (path: string) =>
      Effect.sync(() => {
        checked.push(path);

        return present.has(path);
      }),
  };
};

describe("detectEnvironmentHostTools", () => {
  const cases = [
    {
      name: "macOS app bundles count, and the /usr/bin git stub does not",
      os: "darwin",
      path: "/opt/homebrew/bin:/usr/bin",
      present: [
        "/usr/bin/git",
        "/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild",
        "/opt/homebrew/bin/docker",
        "/Applications/Safari.app",
        "/Applications/Google Chrome.app",
      ],
      expected: ["xcodebuild", "docker", "chrome", "safari"],
    },
    {
      name: "macOS git from the command line tools counts",
      os: "darwin",
      path: "/usr/bin",
      present: ["/Library/Developer/CommandLineTools/usr/bin/git"],
      expected: ["git"],
    },
    {
      name: "Linux tools are found on PATH",
      os: "linux",
      path: "/usr/local/bin::/usr/bin/",
      present: ["/usr/bin/git", "/usr/bin/nvidia-smi", "/usr/local/bin/chromium-browser"],
      expected: ["nvidia-smi", "git", "chromium"],
    },
    {
      name: "Windows adds .exe and checks install folders",
      os: "windows",
      path: "C:\\Tools\\;C:\\Git\\cmd",
      present: [
        "C:\\Git\\cmd\\git.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      ],
      expected: ["git", "edge"],
    },
    {
      name: "xcodebuild and Safari are never found off macOS",
      developerDirectory: "/Applications/Xcode.app",
      os: "linux",
      path: "/usr/bin",
      present: [
        "/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild",
        "/Applications/Safari.app",
        "/usr/bin/xcodebuild",
      ],
      expected: [],
    },
    {
      name: "a renamed Xcode whose developer binaries are on PATH counts",
      os: "darwin",
      path: "/Applications/Xcode_26.0.app/Contents/Developer/usr/bin:/usr/bin",
      present: [
        "/usr/bin/xcodebuild",
        "/Applications/Xcode_26.0.app/Contents/Developer/usr/bin/xcodebuild",
        "/Applications/Xcode_26.0.app/Contents/Developer/usr/bin/git",
      ],
      expected: ["xcodebuild", "git"],
    },
    {
      name: "the Xcode chosen with xcode-select counts",
      os: "darwin",
      path: "/usr/bin",
      present: [
        "/usr/bin/xcodebuild",
        "/usr/bin/git",
        // The selection symlink resolves to /Applications/Xcode_26.0.app/Contents/Developer.
        "/var/db/xcode_select_link/usr/bin/xcodebuild",
        "/var/db/xcode_select_link/usr/bin/git",
      ],
      expected: ["xcodebuild", "git"],
    },
    {
      name: "DEVELOPER_DIR naming the app bundle counts",
      os: "darwin",
      path: "/usr/bin",
      developerDirectory: "/Applications/Xcode_26.0.app/",
      present: ["/Applications/Xcode_26.0.app/Contents/Developer/usr/bin/xcodebuild"],
      expected: ["xcodebuild"],
    },
    {
      name: "DEVELOPER_DIR naming Contents/Developer counts",
      os: "darwin",
      path: "/usr/bin",
      developerDirectory: "/Volumes/Xcodes/Xcode_26.0.app/Contents/Developer",
      present: ["/Volumes/Xcodes/Xcode_26.0.app/Contents/Developer/usr/bin/xcodebuild"],
      expected: ["xcodebuild"],
    },
    {
      name: "Apple's /usr/bin stubs alone mean no Xcode",
      os: "darwin",
      path: "/usr/bin/:/bin",
      present: ["/usr/bin/xcodebuild", "/usr/bin/git", "/Applications/Xcode.app"],
      expected: [],
    },
    {
      name: "the command line tools give git but not xcodebuild",
      os: "darwin",
      path: "/usr/bin",
      present: [
        "/usr/bin/xcodebuild",
        "/usr/bin/git",
        // xcode-select points at the command line tools, which ship git but no xcodebuild.
        "/var/db/xcode_select_link/usr/bin/git",
      ],
      expected: ["git"],
    },
  ] as const;

  for (const testCase of cases) {
    it.effect(testCase.name, () =>
      Effect.gen(function* () {
        const probe = existsIn(testCase.present);

        const tools = yield* detectEnvironmentHostTools({
          os: testCase.os,
          searchPath: splitSearchPath(testCase.path, testCase.os),
          developerDirectory:
            "developerDirectory" in testCase ? testCase.developerDirectory : undefined,
          exists: probe.exists,
        });

        assert.deepStrictEqual(tools, testCase.expected);
      }),
    );
  }
});

describe("memAvailableBytes", () => {
  it("reads MemAvailable, which counts reclaimable cache, not MemFree", () => {
    const meminfo = [
      "MemTotal:       131072000 kB",
      "MemFree:          2097152 kB",
      "MemAvailable:   104857600 kB",
      "Cached:          98304000 kB",
    ].join("\n");

    assert.strictEqual(memAvailableBytes(meminfo), 104_857_600 * 1024);
  });

  it("returns nothing when the field is missing, so the caller falls back", () => {
    assert.isUndefined(memAvailableBytes("MemTotal: 1024 kB\nMemFree: 512 kB"));
  });
});

describe("cpuUtilizationBetween", () => {
  it("measures the busy share and clamps it", () => {
    assert.strictEqual(
      cpuUtilizationBetween({ idleMs: 0, totalMs: 0 }, { idleMs: 75, totalMs: 100 }),
      0.25,
    );
    assert.strictEqual(
      cpuUtilizationBetween({ idleMs: 0, totalMs: 0 }, { idleMs: 0, totalMs: 100 }),
      1,
    );
    assert.strictEqual(
      cpuUtilizationBetween({ idleMs: 10, totalMs: 10 }, { idleMs: 10, totalMs: 10 }),
      null,
    );
  });
});

const codexProvider = (overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-30T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const makeMachine = (cpuReadings: ReadonlyArray<CpuTimes>, present: ReadonlyArray<string>) => {
  const probe = existsIn(present);
  let reading = 0;

  const machine: EnvironmentHostMachine = {
    cpuCount: () => 10,
    cpuTimes: () =>
      Effect.sync(() => {
        const next = cpuReadings[Math.min(reading, cpuReadings.length - 1)];
        reading += 1;

        return next ?? { idleMs: 0, totalMs: 0 };
      }),
    memory: () => Effect.succeed({ availableBytes: 6 * GIB, totalBytes: 24 * GIB }),
    searchPath: () => "/opt/homebrew/bin:/usr/bin",
    developerDirectory: () => undefined,
    exists: probe.exists,
  };

  return { machine, probe, readings: () => reading };
};

const hostLayersWith = <E>(settingsLayer: Layer.Layer<ServerSettings.ServerSettingsService, E>) =>
  Layer.mergeAll(
    settingsLayer,
    Layer.succeed(
      ServerEnvironment,
      ServerEnvironment.of({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("env-mac-mini")),
        getDescriptor: Effect.succeed({
          environmentId: EnvironmentId.make("env-mac-mini"),
          label: "Mac mini",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.0",
          capabilities: { repositoryIdentity: true },
        }),
      }),
    ),
    Layer.mock(ProviderRegistry)({
      getProviders: Effect.succeed([
        codexProvider(),
        codexProvider({
          instanceId: ProviderInstanceId.make("claude"),
          driver: ProviderDriverKind.make("claudeAgent"),
          auth: { status: "unauthenticated" },
        }),
      ]),
    }),
    Layer.mock(ProjectionProjectRepository)({
      listAll: () =>
        Effect.succeed([
          {
            projectId: ProjectId.make("project-app"),
            title: "iOS App",
            workspaceRoot: "/Users/leo/code/ios-app",
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            scripts: [],
            createdAt: "2026-10-01T00:00:00.000Z",
            updatedAt: "2026-10-01T00:00:00.000Z",
            deletedAt: null,
          },
          {
            projectId: ProjectId.make("project-gone"),
            title: "Gone",
            workspaceRoot: "/Users/leo/code/gone",
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            scripts: [],
            createdAt: "2026-10-01T00:00:00.000Z",
            updatedAt: "2026-10-02T00:00:00.000Z",
            deletedAt: "2026-10-02T00:00:00.000Z",
          },
        ]),
    }),
  );

const hostLayers = hostLayersWith(
  ServerSettings.layerTest({
    environmentHost: { labels: ["xcode"], note: "Builds iOS apps.", placementWeight: "prefer" },
  }),
);

/** Settings that read once per entry in `reads`: a profile, or a read failure. */
const scriptedSettings = (reads: ReadonlyArray<"manual-only" | "fail">) => {
  let read = 0;

  return Layer.mock(ServerSettings.ServerSettingsService)({
    getSettings: Effect.suspend(() => {
      const next = reads[Math.min(read, reads.length - 1)];
      read += 1;

      return next === "manual-only"
        ? Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            environmentHost: { labels: ["gpu"], note: "Shared box.", placementWeight: next },
          })
        : Effect.fail(
            new ServerSettingsError({
              settingsPath: "/settings.json",
              operation: "read-file",
              cause: new Error("unreadable"),
            }),
          );
    }),
  });
};

const RATE_LIMITED_AT = "2026-10-30T12:00:00.000Z";

const rateLimitedHealth = {
  subscriptionHealth: () => ({
    health: "failed",
    lastFailedRequest: { at: RATE_LIMITED_AT, message: "Rate limit reached" },
    nextRetryAt: "2026-10-30T12:10:00.000Z",
  }),
};

describe("isProviderReady", () => {
  it("reports a signed-in provider ready when nothing blocks its next turn", () => {
    assert.isTrue(isProviderReady({ provider: codexProvider(), now: Date.parse(RATE_LIMITED_AT) }));
  });

  it("is not ready during an active rate limit, then ready after its retry time", () => {
    const provider = codexProvider();

    assert.isFalse(
      isProviderReady({
        provider,
        health: rateLimitedHealth,
        now: Date.parse("2026-10-30T12:05:00.000Z"),
      }),
    );
    assert.isTrue(
      isProviderReady({
        provider,
        health: rateLimitedHealth,
        now: Date.parse("2026-10-30T12:11:00.000Z"),
      }),
    );
  });

  it("is not ready after a usage cap blocks new turns", () => {
    assert.isFalse(
      isProviderReady({
        provider: codexProvider(),
        health: {
          subscriptionHealth: () => ({
            health: "failed",
            lastFailedRequest: { at: RATE_LIMITED_AT, message: "Usage cap reached" },
          }),
        },
        now: Date.parse(RATE_LIMITED_AT),
      }),
    );
  });

  it("stays ready when only one model failed", () => {
    assert.isTrue(
      isProviderReady({
        provider: codexProvider({
          models: [{ slug: "gpt-new", name: "New", isCustom: false, capabilities: null }],
        }),
        health: {
          subscriptionHealth: () => ({
            health: "failed",
            lastFailedRequest: {
              at: RATE_LIMITED_AT,
              message: "Model gpt-gone not found",
              model: "gpt-gone",
            },
          }),
        },
        now: Date.parse(RATE_LIMITED_AT),
      }),
    );
  });
});

describe("EnvironmentHost", () => {
  it.effect("describes the machine, owner profile, ready providers, and live projects", () =>
    Effect.gen(function* () {
      const { machine } = makeMachine(
        [
          { idleMs: 0, totalMs: 0 },
          { idleMs: 60, totalMs: 100 },
        ],
        [
          "/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild",
          "/Library/Developer/CommandLineTools/usr/bin/git",
        ],
      );

      const host = yield* make(machine, { sampleWindow: Duration.zero });
      const descriptor = yield* host.describe;

      assert.deepStrictEqual(descriptor, {
        environmentId: EnvironmentId.make("env-mac-mini"),
        label: "Mac mini",
        platform: { os: "darwin", arch: "arm64" },
        cpuCount: 10,
        load: {
          cpuUtilization: 0.4,
          availableMemoryBytes: 6 * GIB,
          totalMemoryBytes: 24 * GIB,
          sampleAgeMs: 0,
        },
        tools: ["xcodebuild", "git"],
        providers: [
          {
            instanceId: ProviderInstanceId.make("codex"),
            driver: ProviderDriverKind.make("codex"),
            ready: true,
          },
          {
            instanceId: ProviderInstanceId.make("claude"),
            driver: ProviderDriverKind.make("claudeAgent"),
            ready: false,
          },
        ],
        projects: [
          {
            projectId: ProjectId.make("project-app"),
            title: "iOS App",
            workspaceRoot: "/Users/leo/code/ios-app",
          },
        ],
        profile: { labels: ["xcode"], note: "Builds iOS apps.", placementWeight: "prefer" },
      });
    }).pipe(Effect.provide(hostLayers)),
  );

  it.effect("reuses a fresh load reading, then measures against the last one", () =>
    Effect.gen(function* () {
      const { machine, readings } = makeMachine(
        [
          { idleMs: 0, totalMs: 0 },
          { idleMs: 50, totalMs: 100 },
          { idleMs: 140, totalMs: 200 },
          { idleMs: 1_000, totalMs: 1_000 },
          { idleMs: 1_000, totalMs: 1_100 },
        ],
        [],
      );

      const host = yield* make(machine, { sampleWindow: Duration.zero });

      assert.strictEqual((yield* host.describe).load?.cpuUtilization, 0.5);
      assert.strictEqual(readings(), 2);

      yield* TestClock.adjust(Duration.millis(500));
      const reused = yield* host.describe;
      assert.strictEqual(reused.load?.cpuUtilization, 0.5);
      // The reused reading is reported as 500 ms old, by this server's clock at send time.
      assert.strictEqual(reused.load?.sampleAgeMs, 500);
      assert.strictEqual(readings(), 2);

      yield* TestClock.adjust(Duration.seconds(2));
      const later = yield* host.describe;
      assert.closeTo(later.load?.cpuUtilization ?? Number.NaN, 0.1, 1e-9);
      assert.strictEqual(later.load?.sampleAgeMs, 0);
      assert.strictEqual(readings(), 3);

      yield* TestClock.adjust(Duration.seconds(20));
      assert.strictEqual((yield* host.describe).load?.cpuUtilization, 1);
      assert.strictEqual(readings(), 5);
    }).pipe(Effect.provide(hostLayers)),
  );

  it.effect("checks tool paths once per cache window", () =>
    Effect.gen(function* () {
      const { machine, probe } = makeMachine([{ idleMs: 0, totalMs: 0 }], []);

      const host = yield* make(machine, {
        sampleWindow: Duration.zero,
        toolsTimeToLive: Duration.minutes(10),
      });

      yield* host.describe;
      const firstPass = probe.checked.length;
      assert.isAbove(firstPass, 0);

      yield* host.describe;
      assert.strictEqual(probe.checked.length, firstPass);

      yield* TestClock.adjust(Duration.minutes(11));
      yield* host.describe;
      assert.strictEqual(probe.checked.length, firstPass * 2);
    }).pipe(Effect.provide(hostLayers)),
  );

  it.effect("marks a rate-limited provider not ready in the descriptor", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-30T12:05:00.000Z"));
      const { machine } = makeMachine([{ idleMs: 0, totalMs: 0 }], []);

      const host = yield* make(machine, {
        sampleWindow: Duration.zero,
        providerHealth: {
          subscriptionHealth: (instanceId) =>
            instanceId === "codex" ? rateLimitedHealth.subscriptionHealth() : undefined,
        },
      });

      assert.deepStrictEqual(
        (yield* host.describe).providers.map((provider) => provider.ready),
        [false, false],
      );
    }).pipe(Effect.provide(hostLayers)),
  );

  it.effect("keeps the last readable owner profile when settings fail to read", () =>
    Effect.gen(function* () {
      const { machine } = makeMachine([{ idleMs: 0, totalMs: 0 }], []);
      const host = yield* make(machine, { sampleWindow: Duration.zero });

      const profile: EnvironmentHostProfile = {
        labels: ["gpu"],
        note: "Shared box.",
        placementWeight: "manual-only",
      };

      assert.deepStrictEqual((yield* host.describe).profile, profile);
      assert.deepStrictEqual((yield* host.describe).profile, profile);
    }).pipe(Effect.provide(hostLayersWith(scriptedSettings(["manual-only", "fail"])))),
  );

  it.effect("keeps a host with unreadable settings out of automatic placement", () =>
    Effect.gen(function* () {
      const { machine } = makeMachine([{ idleMs: 0, totalMs: 0 }], []);
      const host = yield* make(machine, { sampleWindow: Duration.zero });

      assert.deepStrictEqual((yield* host.describe).profile, {
        labels: [],
        note: "",
        placementWeight: "manual-only",
      });
    }).pipe(Effect.provide(hostLayersWith(scriptedSettings(["fail"])))),
  );

  it.effect("reports unknown load when no CPU time has passed", () =>
    Effect.gen(function* () {
      const { machine } = makeMachine([{ idleMs: 5, totalMs: 5 }], []);
      const host = yield* make(machine, { sampleWindow: Duration.zero });

      assert.strictEqual((yield* host.describe).load, null);
    }).pipe(Effect.provide(hostLayers)),
  );
});

describe("allowedCpuIds", () => {
  it("reads the CPUs a pinned process may use", () => {
    const status =
      "Name:\tnode\nCpus_allowed:\t0103\nCpus_allowed_list:\t0-1,8\nMems_allowed_list:\t0\n";

    assert.deepStrictEqual([...(allowedCpuIds(status) ?? [])], [0, 1, 8]);
  });

  it("means every CPU when the list is missing or malformed", () => {
    assert.isUndefined(allowedCpuIds("Name:\tnode\n"));
    assert.isUndefined(allowedCpuIds("Cpus_allowed_list:\t3-1\n"));
  });
});

describe("procStatCpuTimes", () => {
  // CPU 1 is offline, so os.cpus() would list cpu3 at position 2.
  const stat = [
    "cpu  300 0 0 300 0 0 0 0 0 0",
    "cpu0 0 0 0 100 0 0 0 0 0 0",
    "cpu2 100 0 0 0 0 0 0 0 0 0",
    "cpu3 0 0 0 100 0 0 0 0 0 0",
    "intr 12345",
  ].join("\n");

  it("sums the allowed CPUs by their ids, not their positions", () => {
    assert.deepStrictEqual(procStatCpuTimes(stat, new Set([2])), { idleMs: 0, totalMs: 100 });
  });

  it("sums every CPU line without an affinity list and skips the aggregate line", () => {
    assert.deepStrictEqual(procStatCpuTimes(stat, undefined), { idleMs: 200, totalMs: 300 });
  });

  it("returns nothing when no allowed CPU appears", () => {
    assert.isUndefined(procStatCpuTimes(stat, new Set([7])));
  });
});

describe("cpuUtilizationBetween across CPU sets", () => {
  it("never compares readings over different CPU sets", () => {
    assert.isNull(
      cpuUtilizationBetween(
        { idleMs: 0, totalMs: 0, cpuSet: "0-31" },
        { idleMs: 0, totalMs: 100, cpuSet: "0" },
      ),
    );
  });
});
