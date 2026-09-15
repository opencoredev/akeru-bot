import { describe, expect, it } from "vite-plus/test";

import { planNightlyRelease } from "./nightly-release.ts";

const base = {
  stableVersion: "1.2.3",
  headSha: "abcdef1234567890abcdef1234567890abcdef12",
  runId: "12345",
  runAttempt: "2",
} as const;

describe("nightly release planning", () => {
  it("creates a collision-safe semver version and separate nightly tag", () => {
    expect(planNightlyRelease(base)).toEqual({
      publish: true,
      version: "1.2.3-nightly.12345.2.gabcdef123456",
      tag: "nightly-v1.2.3-nightly.12345.2.gabcdef123456",
    });
  });

  it("is idempotent after the same commit was released successfully", () => {
    expect(planNightlyRelease({ ...base, previousSha: base.headSha })).toEqual({
      publish: false,
    });
  });

  it("releases a newer main commit and rejects a rewritten history", () => {
    expect(
      planNightlyRelease({ ...base, previousSha: "1234567890abcdef", previousIsAncestor: true }),
    ).toMatchObject({ publish: true });
    expect(() =>
      planNightlyRelease({
        ...base,
        previousSha: "1234567890abcdef",
        previousIsAncestor: false,
      }),
    ).toThrow("not an ancestor");
  });

  it("rejects invalid stable versions and run identities", () => {
    expect(() => planNightlyRelease({ ...base, stableVersion: "1.2.3-beta.1" })).toThrow(
      "Stable release version is invalid",
    );
    expect(() => planNightlyRelease({ ...base, stableVersion: "1.02.3" })).toThrow(
      "Stable release version is invalid",
    );
    expect(() => planNightlyRelease({ ...base, runId: "run-1" })).toThrow("must be numeric");
  });
});
