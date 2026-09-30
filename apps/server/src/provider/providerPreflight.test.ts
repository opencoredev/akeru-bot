import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import { preflightProvider } from "./providerPreflight.ts";

const codexProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-30T00:00:00.000Z",
  models: [
    { slug: "gpt-old", name: "Old", isCustom: false, capabilities: null },
    { slug: "gpt-new", name: "New", isCustom: false, capabilities: null },
    { slug: "gpt-typo", name: "gpt-typo", isCustom: true, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
};

const failedAt = "2026-09-30T12:00:00.000Z";
const at = (offsetMs: number) => Date.parse(failedAt) + offsetMs;

const preflightAfterFailure = (
  message: string,
  options: {
    readonly model?: string;
    readonly failedModel?: string;
    readonly now: number;
    readonly nextRetryAt?: string;
  },
) =>
  preflightProvider({
    providers: [codexProvider],
    providerId: "codex",
    model: options.model ?? "gpt-new",
    now: options.now,
    subscriptionHealth: () => ({
      health: "failed",
      lastFailedRequest: {
        at: failedAt,
        message,
        ...(options.failedModel ? { model: options.failedModel } : {}),
      },
      ...(options.nextRetryAt ? { nextRetryAt: options.nextRetryAt } : {}),
    }),
  });

describe("preflightProvider recorded request failures", () => {
  it("blocks a new turn during a recent rate limit", () => {
    expect(
      preflightAfterFailure("Rate limit reached, try again later", { now: at(10_000) })?.category,
    ).toBe("limit-reached");
  });

  it("lets a turn retry once the rate limit window has passed", () => {
    expect(
      preflightAfterFailure("Rate limit reached, try again later", { now: at(5 * 60_000) }),
    ).toBeUndefined();
  });

  it("honors the provider's retry time over the default window", () => {
    const nextRetryAt = "2026-09-30T12:10:00.000Z";
    expect(
      preflightAfterFailure("Too many requests", { now: at(5 * 60_000), nextRetryAt })?.category,
    ).toBe("limit-reached");
    expect(
      preflightAfterFailure("Too many requests", { now: at(11 * 60_000), nextRetryAt }),
    ).toBeUndefined();
  });

  it("validates the selected model instead of replaying an old model error", () => {
    expect(
      preflightAfterFailure("Model gpt-gone not found", { model: "gpt-new", now: at(1_000) }),
    ).toBeUndefined();
    expect(
      preflightAfterFailure("Model gpt-gone not found", { model: "gpt-gone", now: at(1_000) })
        ?.category,
    ).toBe("unsupported-model");
  });

  it("keeps blocking an unchanged custom model the provider rejected", () => {
    const failure = "Model gpt-typo not found";
    expect(
      preflightAfterFailure(failure, { model: "gpt-typo", failedModel: "gpt-typo", now: at(1_000) })
        ?.category,
    ).toBe("unsupported-model");
    expect(
      preflightAfterFailure(failure, { model: "gpt-new", failedModel: "gpt-typo", now: at(1_000) }),
    ).toBeUndefined();
    expect(preflightAfterFailure(failure, { model: "gpt-typo", now: at(1_000) })).toBeUndefined();
  });

  it("still blocks on a recorded login failure", () => {
    expect(preflightAfterFailure("Refresh token expired", { now: at(60 * 60_000) })?.category).toBe(
      "expired-login",
    );
  });
});

const provider = (overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make("claude"),
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "Claude",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [{ slug: "claude-sonnet", name: "Claude Sonnet", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const preflight = (snapshot: ServerProvider, model = "claude-sonnet") =>
  preflightProvider({
    providers: [snapshot],
    providerId: "claude",
    model,
    now: Date.parse("2026-01-01T00:00:00.000Z"),
  });

describe("preflightProvider", () => {
  it("lets a ready provider with a listed model through", () => {
    expect(preflight(provider())).toBeUndefined();
  });

  it("lets an unprobed provider proceed until its adapter is checked", () => {
    expect(
      preflightProvider({ providers: [], providerId: "claude", model: "claude-sonnet", now: 0 }),
    ).toBeUndefined();
  });

  it("reports a disabled provider before any stale probe failure", () => {
    expect(
      preflight(
        provider({
          enabled: false,
          status: "disabled",
          unavailability: "temporary-failure",
          unavailabilityDetail: "socket closed",
        }),
      ),
    ).toEqual({
      category: "temporary-failure",
      detail: "Claude is turned off in Settings > Providers.",
      repairAction: "providers",
    });
  });

  it("points login failures at Providers and usage caps at usage", () => {
    expect(
      preflight(provider({ unavailability: "expired-login", unavailabilityDetail: "expired" })),
    ).toEqual({ category: "expired-login", detail: "expired", repairAction: "providers" });
    expect(
      preflight(provider({ unavailability: "usage-cap", unavailabilityDetail: "cap" })),
    ).toEqual({ category: "usage-cap", detail: "cap", repairAction: "usage" });
    expect(preflight(provider({ auth: { status: "unauthenticated" } }))?.category).toBe(
      "missing-login",
    );
  });

  it("rejects a model the provider no longer lists", () => {
    expect(preflight(provider(), "claude-9")?.category).toBe("unsupported-model");
  });
  it("blocks revoked shared Kimi credentials despite a ready snapshot", () => {
    const kimi = provider({
      instanceId: ProviderInstanceId.make("kimi"),
      driver: ProviderDriverKind.make("kimi"),
      displayName: "Kimi",
    });
    const baseStatus = {
      provider: "kimi-for-coding" as const,
      connected: true,
      reconnectAction: "Reconnect Kimi",
      healthTest: { status: "not-run" as const },
      dependentBots: [],
      dependentRoutines: [],
    };
    for (const health of ["revoked", "expired"] as const) {
      expect(
        preflightProvider({
          providers: [kimi],
          providerId: "kimi",
          model: "claude-sonnet",
          now: Date.parse("2026-01-01T00:00:00.000Z"),
          subscriptionStatuses: [{ ...baseStatus, health }],
          subscriptionHealth: () => ({
            health: "failed",
            lastFailedRequest: { message: "temporary gateway failure" },
          }),
        }),
      ).toMatchObject({ category: "expired-login", repairAction: "providers" });
    }
  });

  it("ignores shared subscription health for an independently credentialed instance", () => {
    expect(
      preflightProvider({
        providers: [provider()],
        providerId: "claude",
        model: "claude-sonnet",
        now: Date.parse("2026-01-01T00:00:00.000Z"),
        providerInstanceConfig: {
          driver: ProviderDriverKind.make("claudeAgent"),
          environment: [{ name: "ANTHROPIC_API_KEY", value: "own-key", sensitive: true }],
        },
        subscriptionStatuses: [
          {
            provider: "anthropic",
            connected: false,
            health: "revoked",
            reconnectAction: "Reconnect Claude",
            healthTest: { status: "not-run" },
            dependentBots: [],
            dependentRoutines: [],
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("lets a saved OAuth login refresh its expired access token", () => {
    const claude = provider({
      auth: { status: "unauthenticated" },
      availability: "unavailable",
      unavailability: "expired-login",
    });
    const status = {
      provider: "anthropic" as const,
      connected: true,
      authMode: "oauth" as const,
      health: "expired" as const,
      reconnectAction: "Reconnect Claude",
      healthTest: { status: "not-run" as const },
      dependentBots: [],
      dependentRoutines: [],
    };
    expect(
      preflightProvider({
        providers: [claude],
        providerId: "claude",
        model: "claude-sonnet",
        now: Date.parse("2026-01-01T00:00:00.000Z"),
        subscriptionStatuses: [status],
      }),
    ).toBeUndefined();
    expect(
      preflightProvider({
        providers: [claude],
        providerId: "claude",
        model: "claude-sonnet",
        now: Date.parse("2026-01-01T00:00:00.000Z"),
        subscriptionStatuses: [status],
        subscriptionHealth: () => ({
          health: "failed",
          lastFailedRequest: { message: "401 Unauthorized" },
        }),
      }),
    ).toBeUndefined();
    expect(
      preflightProvider({
        providers: [claude],
        providerId: "claude",
        model: "claude-sonnet",
        now: Date.parse("2026-01-01T00:00:00.000Z"),
        subscriptionStatuses: [{ ...status, health: "revoked" }],
      })?.category,
    ).toBe("expired-login");
  });
});
