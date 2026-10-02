import { describe, expect, it } from "vite-plus/test";
import { decodePendingLogins, decodeProviderHealth } from "./persistedSchemas.ts";

describe("subscription state compatibility", () => {
  it("keeps active logins beside retired provider records and retains extra metadata", () => {
    const entries = [
      ["retired", { provider: "cursor", pending: { legacy: true } }],
      [
        "active",
        {
          provider: "anthropic",
          verifier: "verifier",
          instanceId: "claude-work",
          future: "metadata",
        },
      ],
    ];

    expect(decodePendingLogins(JSON.stringify(entries))).toEqual(entries);
  });

  it("retains health metadata written by another version", () => {
    const health = {
      codex: { lastSuccessfulRequestAt: "2026-10-01T00:00:00Z", futureHealth: { attempts: 2 } },
    };

    expect(decodeProviderHealth(JSON.stringify(health))).toEqual(health);
  });

  it("rejects malformed persisted login and health fields", () => {
    expect(() =>
      decodePendingLogins('[ ["login", {"provider":"anthropic","verifier":false}] ]'),
    ).toThrow();
    expect(() =>
      decodeProviderHealth('{"codex":{"healthTest":{"status":"passed","checkedAt":7}}}'),
    ).toThrow();
  });
});
