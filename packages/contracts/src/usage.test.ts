import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { UsageSummary } from "./usage.ts";

const decodeSummary = Schema.decodeUnknownSync(UsageSummary);

const totals = {
  uncachedInputTokens: 10,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 5,
  reasoningTokens: 0,
};

const bucket = (provider: string) => ({
  day: "2026-09-20",
  provider,
  model: "model",
  totals,
  costUsd: 0,
  cacheSavingsUsd: 0,
  costSource: "unpriced",
  records: 1,
  unpricedRecords: 1,
  sessions: 1,
});

const source = (provider: string) => ({
  fingerprint: { hostId: "host", provider, resolvedHomePath: "/home/user", volumeId: "" },
  status: "ok",
  scannedFiles: 1,
  skippedFiles: 0,
  malformedRecords: 0,
  distinctSessions: 1,
  message: null,
});

describe("UsageSummary", () => {
  it("keeps other providers when a version-5 server still reports Cursor usage", () => {
    const summary = decodeSummary({
      contractVersion: 5,
      readAt: "2026-09-20T12:00:00.000Z",
      timeZone: "UTC",
      sinceDay: "2026-09-14",
      untilDay: "2026-09-20",
      buckets: [bucket("cursor"), bucket("claude")],
      sources: [source("cursor"), source("claude")],
      pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 1 },
      scanDurationMs: 3,
      planLimits: [
        { provider: "cursor", status: "ok", plan: null, message: null, windows: [] },
        { provider: "anthropic", status: "ok", plan: null, message: null, windows: [] },
      ],
      connectedProviders: ["cursor", "anthropic"],
    });

    expect(summary.buckets.map((entry) => entry.provider)).toEqual(["claude"]);
    expect(summary.sources.map((entry) => entry.fingerprint.provider)).toEqual(["claude"]);
    expect(summary.planLimits?.map((entry) => entry.provider)).toEqual(["anthropic"]);
    expect(summary.connectedProviders).toEqual(["anthropic"]);
  });
});
