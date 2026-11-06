import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ENVIRONMENT_HOST_LABEL_MAX_CHARS,
  ENVIRONMENT_HOST_LABELS_MAX,
  ENVIRONMENT_HOST_NOTE_MAX_CHARS,
  EnvironmentHostLoad,
  EnvironmentHostProfile,
  EnvironmentHostRequirements,
} from "./environmentHost.ts";
import { DEFAULT_SERVER_SETTINGS, ServerSettings } from "./settings.ts";

const decodeProfile = Schema.decodeUnknownExit(EnvironmentHostProfile);

const decodeProfileSync = Schema.decodeUnknownSync(EnvironmentHostProfile);

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);

const decodeLoad = Schema.decodeUnknownExit(EnvironmentHostLoad);

const decodeRequirements = Schema.decodeUnknownSync(EnvironmentHostRequirements);

const decodeRequirementsExit = Schema.decodeUnknownExit(EnvironmentHostRequirements);

describe("EnvironmentHostProfile", () => {
  it("defaults to an undescribed environment with normal weight", () => {
    expect(DEFAULT_SERVER_SETTINGS.environmentHost).toEqual({
      labels: [],
      note: "",
      placementWeight: "normal",
    });
    expect(decodeSettings({}).environmentHost).toEqual(DEFAULT_SERVER_SETTINGS.environmentHost);
  });

  it("trims labels and the note", () => {
    expect(
      decodeProfileSync({
        labels: [" gpu "],
        note: "  Fast box  ",
        placementWeight: "prefer",
      }),
    ).toEqual({ labels: ["gpu"], note: "Fast box", placementWeight: "prefer" });
  });

  it.each([
    ["an empty label", { labels: [""] }],
    ["a long label", { labels: ["x".repeat(ENVIRONMENT_HOST_LABEL_MAX_CHARS + 1)] }],
    [
      "too many labels",
      { labels: Array.from({ length: ENVIRONMENT_HOST_LABELS_MAX + 1 }, (_, i) => `l${i}`) },
    ],
    ["duplicate labels", { labels: ["gpu", "gpu"] }],
    ["a long note", { note: "x".repeat(ENVIRONMENT_HOST_NOTE_MAX_CHARS + 1) }],
    ["an unknown weight", { placementWeight: "always" }],
  ])("rejects %s", (_name, input) => {
    expect(decodeProfile(input)._tag).toBe("Failure");
  });
});

describe("EnvironmentHostLoad", () => {
  it("keeps CPU utilization between 0 and 1", () => {
    const load = {
      availableMemoryBytes: 1,
      totalMemoryBytes: 2,
      sampleAgeMs: 0,
    };

    expect(decodeLoad({ ...load, cpuUtilization: 1 })._tag).toBe("Success");
    expect(decodeLoad({ ...load, cpuUtilization: 1.2 })._tag).toBe("Failure");
  });
});

describe("EnvironmentHostRequirements", () => {
  it("accepts the macOS build requirement and refuses unknown tools", () => {
    expect(
      decodeRequirements({
        os: "darwin",
        tools: ["xcodebuild"],
      }),
    ).toEqual({ os: "darwin", tools: ["xcodebuild"] });
    expect(decodeRequirementsExit({ tools: ["vim"] })._tag).toBe("Failure");
  });
});
