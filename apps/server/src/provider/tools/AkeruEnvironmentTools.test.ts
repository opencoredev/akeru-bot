import {
  type AkeruToolInputSchemas,
  type EnvironmentHostDescriptor,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createListEnvironmentsHandler } from "./AkeruEnvironmentTools.ts";

const NOW_MS = Date.parse("2026-10-30T12:00:00.000Z");

const HOME = EnvironmentId.make("env-mac-mini");

const LINUX = EnvironmentId.make("env-linux");

const local: EnvironmentHostDescriptor = {
  environmentId: HOME,
  label: "Mac mini",
  platform: { os: "darwin", arch: "arm64" },
  cpuCount: 10,
  load: {
    cpuUtilization: 0.25,
    availableMemoryBytes: 8,
    totalMemoryBytes: 32,
    sampleAgeMs: 1_000,
  },
  tools: ["git", "xcodebuild"],
  providers: [
    {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      ready: true,
    },
  ],
  projects: [],
  profile: { labels: ["xcode"], note: "Builds iOS apps.", placementWeight: "normal" },
};

const handler = (allowed: ReadonlyArray<EnvironmentId>) =>
  createListEnvironmentsHandler({
    describeLocal: async () => local,
    allowedEnvironmentIds: async () => allowed,
    now: async () => NOW_MS,
  });

const run = (
  input: (typeof AkeruToolInputSchemas)["list_environments"]["Encoded"],
  allowed: ReadonlyArray<EnvironmentId> = [],
) => handler(allowed)({ input, emitProgress: () => undefined });

describe("list_environments", () => {
  it("lists this environment with a compact descriptor", async () => {
    await expect(run({})).resolves.toEqual({
      eligible: [
        {
          environmentId: HOME,
          label: "Mac mini",
          home: true,
          os: "darwin",
          arch: "arm64",
          cpuCount: 10,
          cpuUtilization: 0.25,
          freeMemoryShare: 0.25,
          tools: ["git", "xcodebuild"],
          readyProviders: ["codex"],
          projects: [],
          labels: ["xcode"],
          note: "Builds iOS apps.",
          placementWeight: "normal",
          automaticPlacement: "score 1.88",
        },
      ],
      excluded: [],
    });
  });

  it("explains why an environment does not meet the requirements", async () => {
    await expect(run({ requirements: { os: "linux", tools: ["docker"] } })).resolves.toEqual({
      eligible: [],
      excluded: [
        {
          environmentId: HOME,
          reasons: ["Needs linux, but it runs darwin.", "Missing docker."],
        },
      ],
    });
  });

  it("says when other allowed environments cannot be seen from here", async () => {
    const result = await run({}, [LINUX]);

    expect(result).toMatchObject({
      excluded: [{ environmentId: LINUX, reasons: ["The environment is not connected."] }],
      visibility:
        "Only this environment is visible from here. Other allowed environments are listed as not connected.",
    });
  });

  it("rejects unknown requirement fields", async () => {
    await expect(
      handler([])({ input: { requirements: { gpu: true } }, emitProgress: () => undefined }),
    ).rejects.toThrow();
  });
});
