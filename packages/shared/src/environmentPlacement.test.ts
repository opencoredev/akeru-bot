import {
  type EnvironmentHostDescriptor,
  type EnvironmentHostLoad,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type PlacementCandidate,
  type PlacementInput,
  type PlacementResult,
  placeWork,
  placementCandidates,
} from "./environmentPlacement.ts";

const NOW_MS = Date.parse("2026-10-30T12:00:00.000Z");

/** Sample ages as the server reports them, in milliseconds. */
const FRESH = 2_000;

const STALE = 16_000;

const GIB = 1024 ** 3;

const HOME = EnvironmentId.make("env-laptop");

const MAC = EnvironmentId.make("env-mac-mini");

const LINUX = EnvironmentId.make("env-linux");

const CODEX = ProviderDriverKind.make("codex");

const load = (overrides: Partial<EnvironmentHostLoad> = {}): EnvironmentHostLoad => ({
  cpuUtilization: 0.5,
  availableMemoryBytes: 8 * GIB,
  totalMemoryBytes: 16 * GIB,
  sampleAgeMs: FRESH,
  ...overrides,
});

const describeHost = (
  environmentId: EnvironmentId,
  overrides: Partial<EnvironmentHostDescriptor> = {},
): EnvironmentHostDescriptor => ({
  environmentId,
  label: environmentId,
  platform: { os: "linux", arch: "x64" },
  cpuCount: 8,
  load: load(),
  tools: ["git"],
  providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: CODEX, ready: true }],
  projects: [
    {
      projectId: ProjectId.make(`${environmentId}-akeru`),
      title: "Akeru Bot",
      workspaceRoot: "/home/leo/code/akeru-bot",
    },
  ],
  profile: { labels: [], note: "", placementWeight: "normal" },
  ...overrides,
});

const online = (
  descriptor: EnvironmentHostDescriptor,
  receivedAtMs: number = NOW_MS,
): PlacementCandidate => ({
  kind: "online",
  descriptor,
  receivedAtMs,
});

/**
 * A descriptor built the way a server does: the reading's age measured on the
 * server's own clock at send time. `clockOffsetMs` is how far the server's
 * clock is ahead of the caller's, which must not matter.
 */
const sentByServer = (input: {
  readonly clockOffsetMs: number;
  readonly sampledAgoMs: number;
}): EnvironmentHostDescriptor => {
  const serverNowMs = NOW_MS + input.clockOffsetMs;
  const serverSampledMs = serverNowMs - input.sampledAgoMs;

  return describeHost(LINUX, { load: load({ sampleAgeMs: serverNowMs - serverSampledMs }) });
};

const isStale = (candidate: PlacementCandidate, nowMs: number = NOW_MS): boolean => {
  const [report] = placementCandidates(
    base({
      nowMs,
      allowedEnvironmentIds: [LINUX],
      homeEnvironmentId: LINUX,
      candidates: [candidate],
    }),
  );

  return (
    report?.kind === "excluded" &&
    report.exclusions.some((exclusion) => exclusion.reason === "stale-load")
  );
};

const mac = describeHost(MAC, {
  platform: { os: "darwin", arch: "arm64" },
  tools: ["git", "xcodebuild", "safari"],
  profile: { labels: ["mac-mini"], note: "Xcode lives here.", placementWeight: "normal" },
});

const base = (overrides: Partial<PlacementInput>): PlacementInput => ({
  nowMs: NOW_MS,
  homeEnvironmentId: HOME,
  allowedEnvironmentIds: [MAC, LINUX],
  candidates: [online(describeHost(HOME)), online(mac), online(describeHost(LINUX))],
  ...overrides,
});

/** The fields a reader checks first: what happened and where. */
const outcome = (result: PlacementResult) => {
  switch (result.kind) {
    case "unplaced":
      return { kind: result.kind };
    case "choice-ineligible":
      return {
        kind: result.kind,
        environmentId: result.environmentId,
        reasons: result.exclusions.map((exclusion) => exclusion.reason),
      };
    case "placed":
      return { kind: result.kind, environmentId: result.environmentId, via: result.via };
  }
};

describe("placeWork", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly input: PlacementInput;
    readonly expected: ReturnType<typeof outcome>;
  }> = [
    {
      name: "requirements narrow placement to the Mac",
      input: base({ requirements: { os: "darwin", tools: ["xcodebuild"] } }),
      expected: { kind: "placed", environmentId: MAC, via: "score" },
    },
    {
      name: "labels and projects are hard requirements",
      input: base({ requirements: { labels: ["MAC-MINI"], project: "akeru-bot" } }),
      expected: { kind: "placed", environmentId: MAC, via: "score" },
    },
    {
      name: "the highest score wins: more idle cores beat a busier host",
      input: base({
        candidates: [
          online(describeHost(HOME, { load: load({ cpuUtilization: 0.8 }) })),
          online(describeHost(LINUX, { cpuCount: 32, load: load({ cpuUtilization: 0.2 }) })),
        ],
      }),
      expected: { kind: "placed", environmentId: LINUX, via: "score" },
    },
    {
      name: "a stale load reading excludes the host",
      input: base({
        candidates: [
          online(describeHost(HOME, { load: load({ cpuUtilization: 0.9 }) })),
          online(describeHost(LINUX, { cpuCount: 64, load: load({ sampleAgeMs: STALE }) })),
        ],
      }),
      expected: { kind: "placed", environmentId: HOME, via: "score" },
    },
    {
      name: "overloaded CPU and low memory are skipped by scoring",
      input: base({
        candidates: [
          online(describeHost(HOME, { load: load({ cpuUtilization: 0.95 }) })),
          online(
            describeHost(LINUX, {
              cpuCount: 64,
              load: load({ availableMemoryBytes: Math.floor(0.05 * 16 * GIB) }),
            }),
          ),
        ],
      }),
      expected: { kind: "unplaced" },
    },
    {
      name: "unknown load ranks below any host with known load",
      input: base({
        candidates: [
          online(describeHost(HOME, { load: load({ cpuUtilization: 0.9 }) })),
          online(describeHost(LINUX, { cpuCount: 64, load: null })),
        ],
      }),
      expected: { kind: "placed", environmentId: HOME, via: "score" },
    },
    {
      name: "unknown load is used when nothing else qualifies",
      input: base({
        candidates: [
          online(describeHost(HOME, { load: load({ cpuUtilization: 0.99 }) })),
          online(describeHost(LINUX, { load: null })),
        ],
      }),
      expected: { kind: "placed", environmentId: LINUX, via: "unknown-load" },
    },
    {
      name: "manual-only is never picked automatically",
      input: base({
        requirements: { os: "darwin" },
        candidates: [
          online({ ...mac, profile: { ...mac.profile, placementWeight: "manual-only" } }),
        ],
      }),
      expected: { kind: "unplaced" },
    },
    {
      name: "manual-only can be picked by the user explicitly",
      input: base({
        userChoice: MAC,
        candidates: [
          online({ ...mac, profile: { ...mac.profile, placementWeight: "manual-only" } }),
        ],
      }),
      expected: { kind: "placed", environmentId: MAC, via: "user-choice" },
    },
    {
      name: "the bot cannot pick a manual-only host",
      input: base({
        botChoice: MAC,
        candidates: [
          online(describeHost(HOME)),
          online({ ...mac, profile: { ...mac.profile, placementWeight: "manual-only" } }),
        ],
      }),
      expected: { kind: "placed", environmentId: HOME, via: "score" },
    },
    {
      name: "an explicit choice outside the eligible set is an error, not an override",
      input: base({ userChoice: HOME, requirements: { os: "darwin" } }),
      expected: { kind: "choice-ineligible", environmentId: HOME, reasons: ["os-mismatch"] },
    },
    {
      name: "an explicit choice of an unknown environment is an error",
      input: base({ userChoice: EnvironmentId.make("env-gone"), allowedEnvironmentIds: [] }),
      expected: {
        kind: "choice-ineligible",
        environmentId: EnvironmentId.make("env-gone"),
        reasons: ["unknown-environment"],
      },
    },
    {
      name: "an explicit choice the bot is not allowed on is an error",
      input: base({ userChoice: MAC, allowedEnvironmentIds: [] }),
      expected: { kind: "choice-ineligible", environmentId: MAC, reasons: ["not-allowed"] },
    },
    {
      name: "the bot's eligible choice beats a higher score",
      input: base({
        botChoice: HOME,
        candidates: [
          online(describeHost(HOME, { load: load({ cpuUtilization: 0.9 }) })),
          online(describeHost(LINUX, { cpuCount: 64 })),
        ],
      }),
      expected: { kind: "placed", environmentId: HOME, via: "bot-choice" },
    },
    {
      name: "the user's choice beats the bot's choice",
      input: base({ userChoice: LINUX, botChoice: HOME }),
      expected: { kind: "placed", environmentId: LINUX, via: "user-choice" },
    },
    {
      name: "weights scale the score",
      input: base({
        candidates: [
          online(describeHost(HOME)),
          online(
            describeHost(LINUX, {
              profile: { labels: [], note: "", placementWeight: "less-often" },
            }),
          ),
        ],
      }),
      expected: { kind: "placed", environmentId: HOME, via: "score" },
    },
    {
      name: "a tie goes to the home environment",
      input: base({ candidates: [online(describeHost(LINUX)), online(describeHost(HOME))] }),
      expected: { kind: "placed", environmentId: HOME, via: "score" },
    },
    {
      name: "a tie between other environments goes to the lower environment id",
      input: base({
        candidates: [
          online(describeHost(HOME, { load: load({ cpuUtilization: 0.9 }) })),
          online(describeHost(MAC)),
          online(describeHost(LINUX)),
        ],
      }),
      expected: { kind: "placed", environmentId: LINUX, via: "score" },
    },
    {
      name: "a bot with the default allowed list stays home",
      input: base({ allowedEnvironmentIds: [] }),
      expected: { kind: "placed", environmentId: HOME, via: "score" },
    },
    {
      name: "the provider must be ready",
      input: base({
        provider: CODEX,
        candidates: [
          online(
            describeHost(HOME, {
              providers: [
                { instanceId: ProviderInstanceId.make("codex"), driver: CODEX, ready: false },
              ],
            }),
          ),
          online(describeHost(LINUX, { load: load({ cpuUtilization: 0.9 }) })),
        ],
      }),
      expected: { kind: "placed", environmentId: LINUX, via: "score" },
    },
  ];

  for (const { name, input, expected } of cases) {
    it(name, () => {
      expect(outcome(placeWork(input))).toEqual(expected);
    });
  }

  it("reports the bot's rejected choice", () => {
    const result = placeWork(base({ botChoice: MAC, requirements: { os: "linux" } }));

    expect(result.kind === "placed" ? result.rejectedBotChoice : "wrong kind").toBe(MAC);
  });
});

describe("placementCandidates", () => {
  it("explains every exclusion for each environment", () => {
    const reports = placementCandidates(
      base({
        allowedEnvironmentIds: [MAC, LINUX, EnvironmentId.make("env-vps")],
        requirements: { os: "darwin", tools: ["xcodebuild", "docker"], project: "missing" },
        provider: CODEX,
        candidates: [
          online(describeHost(HOME, { load: load({ sampleAgeMs: STALE }) })),
          online(mac),
          { kind: "offline", environmentId: LINUX },
          online(describeHost(EnvironmentId.make("env-stranger"))),
        ],
      }),
    );

    expect(
      reports.map((report) =>
        report.kind === "eligible"
          ? [report.environmentId, "eligible"]
          : [report.environmentId, report.exclusions.map((exclusion) => exclusion.reason)],
      ),
    ).toEqual([
      [HOME, ["stale-load", "os-mismatch", "missing-tools", "missing-project"]],
      [MAC, ["missing-tools", "missing-project"]],
      [LINUX, ["offline"]],
      ["env-stranger", ["not-allowed", "os-mismatch", "missing-tools", "missing-project"]],
      ["env-vps", ["offline"]],
    ]);
  });

  it("names the missing tools", () => {
    const [home] = placementCandidates(
      base({
        candidates: [online(describeHost(HOME))],
        requirements: { tools: ["git", "docker", "nvidia-smi"] },
      }),
    );

    expect(home?.kind === "excluded" ? home.exclusions : []).toEqual([
      { reason: "missing-tools", tools: ["docker", "nvidia-smi"] },
    ]);
  });

  it("treats an undescribed environment as excluded, not unknown load", () => {
    const [home] = placementCandidates(
      base({ candidates: [{ kind: "undescribed", environmentId: HOME }] }),
    );

    expect(home).toEqual({
      kind: "excluded",
      environmentId: HOME,
      exclusions: [{ reason: "no-descriptor" }],
    });
  });
});

describe("load freshness across machines", () => {
  it("keeps a fresh reading from a server whose clock is 60s behind", () => {
    expect(isStale(online(sentByServer({ clockOffsetMs: -60_000, sampledAgoMs: 1_000 })))).toBe(
      false,
    );
  });

  it("drops a 60s-old reading from a server whose clock is 120s ahead", () => {
    expect(isStale(online(sentByServer({ clockOffsetMs: 120_000, sampledAgoMs: 60_000 })))).toBe(
      true,
    );
  });

  it("ages a reading by the time since the caller received it, on the caller's clock", () => {
    const received = online(
      sentByServer({ clockOffsetMs: 3_600_000, sampledAgoMs: 2_000 }),
      NOW_MS - 12_000,
    );

    expect(isStale(received, NOW_MS)).toBe(false);
    expect(isStale(received, NOW_MS + 2_000)).toBe(true);
  });

  it("does not make a reading younger when the receipt time is in the caller's future", () => {
    const received = online(
      sentByServer({ clockOffsetMs: 0, sampledAgoMs: STALE }),
      NOW_MS + 60_000,
    );

    expect(isStale(received)).toBe(true);
  });

  it("reports the age in the exclusion", () => {
    const [report] = placementCandidates(
      base({
        homeEnvironmentId: LINUX,
        allowedEnvironmentIds: [],
        candidates: [
          online(describeHost(LINUX, { load: load({ sampleAgeMs: 10_000 }) }), NOW_MS - 7_000),
        ],
      }),
    );

    expect(report?.kind === "excluded" ? report.exclusions : []).toEqual([
      { reason: "stale-load", ageMs: 17_000 },
    ]);
  });
});
