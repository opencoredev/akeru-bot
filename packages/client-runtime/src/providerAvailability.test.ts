import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationThreadActivity,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  latestTurnFailure,
  presentProviderUnavailability,
  providerAvailabilityReason,
  type ProviderAvailabilityReason,
} from "./providerAvailability.ts";

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

const activity = (
  overrides: Partial<OrchestrationThreadActivity> & { kind: string; createdAt: string },
): OrchestrationThreadActivity => ({
  id: EventId.make(`activity-${overrides.createdAt}`),
  tone: "error",
  summary: "Provider turn start failed",
  payload: {},
  turnId: null,
  ...overrides,
});

describe("providerAvailabilityReason", () => {
  it("allows a ready provider and a listed model", () => {
    expect(providerAvailabilityReason(provider(), "claude-sonnet")).toBeNull();
  });

  it("follows the server preflight order", () => {
    expect(providerAvailabilityReason(undefined)).toBe("missing-provider");
    expect(
      providerAvailabilityReason(provider({ enabled: false, unavailability: "limit-reached" })),
    ).toBe("disabled");
    expect(providerAvailabilityReason(provider({ installed: false }))).toBe("not-installed");
    expect(providerAvailabilityReason(provider({ availability: "unavailable" }))).toBe(
      "not-installed",
    );
    expect(
      providerAvailabilityReason(
        provider({ unavailability: "expired-login", auth: { status: "unauthenticated" } }),
      ),
    ).toBe("expired-login");
    expect(providerAvailabilityReason(provider({ auth: { status: "unauthenticated" } }))).toBe(
      "missing-login",
    );
    expect(providerAvailabilityReason(provider(), "claude-9")).toBe("unsupported-model");
  });

  it("reports a recorded category before a missing install, like the server", () => {
    const snapshot = provider({
      installed: false,
      availability: "unavailable",
      unavailability: "missing-login",
    });
    const reason = providerAvailabilityReason(snapshot);
    expect(reason).toBe("missing-login");
    expect(
      presentProviderUnavailability({ reason: reason!, providerName: "Claude" }),
    ).toMatchObject({
      title: "Claude is not connected",
      description: "Connect your Claude account in Settings > Providers.",
      action: "providers",
    });
  });

  it("does not reject models for a provider that lists none", () => {
    expect(providerAvailabilityReason(provider({ models: [] }), "anything")).toBeNull();
  });
});

describe("presentProviderUnavailability", () => {
  const reasons: ReadonlyArray<ProviderAvailabilityReason> = [
    "missing-provider",
    "disabled",
    "not-installed",
    "missing-login",
    "expired-login",
    "unsupported-model",
    "limit-reached",
    "usage-cap",
    "temporary-failure",
  ];

  it("gives every reason distinct copy without em dashes or thread wording", () => {
    const titles = new Set<string>();
    for (const reason of reasons) {
      const presentation = presentProviderUnavailability({
        reason,
        providerName: "Claude",
        modelName: "Claude Sonnet",
      });
      titles.add(presentation.title);
      const copy = `${presentation.title} ${presentation.description}`;
      expect(copy).not.toMatch(/—|\bthread\b/i);
    }
    expect(titles.size).toBe(reasons.length);
  });

  it("names the provider and points login failures at Settings > Providers", () => {
    expect(
      presentProviderUnavailability({ reason: "expired-login", providerName: "Codex" }),
    ).toMatchObject({
      title: "Codex sign-in expired",
      description: "Reconnect Codex in Settings > Providers, then send your message again.",
      action: "providers",
    });
    expect(
      presentProviderUnavailability({ reason: "usage-cap", providerName: "Codex" }).action,
    ).toBe("usage");
  });

  it("keeps a bounded provider detail for the technical details", () => {
    expect(
      presentProviderUnavailability({
        reason: "limit-reached",
        providerName: "Kimi For Coding",
        detail: "rate limit exceeded\n    at file:///home/leo/x.ts",
      }).technicalDetails,
    ).toBe("rate limit exceeded");
  });
});

describe("latestTurnFailure", () => {
  it("reads the category from a turn start failure after the user message", () => {
    expect(
      latestTurnFailure(
        [
          activity({ kind: "provider.turn.start.failed", createdAt: "2026-01-01T00:00:00.000Z" }),
          activity({
            kind: "provider.turn.start.failed",
            createdAt: "2026-01-01T00:00:02.000Z",
            payload: { detail: "OAuth token expired", unavailability: "expired-login" },
          }),
        ],
        "2026-01-01T00:00:01.000Z",
      ),
    ).toEqual({ detail: "OAuth token expired", unavailability: "expired-login" });
  });

  it("reads a mid-turn runtime error without a category", () => {
    expect(
      latestTurnFailure([
        activity({
          kind: "runtime.error",
          createdAt: "2026-01-01T00:00:02.000Z",
          payload: { message: "socket closed" },
        }),
      ]),
    ).toEqual({ detail: "socket closed", unavailability: null });
  });

  it("ignores failures older than the latest user message", () => {
    expect(
      latestTurnFailure(
        [activity({ kind: "runtime.error", createdAt: "2026-01-01T00:00:00.000Z" })],
        "2026-01-01T00:00:01.000Z",
      ),
    ).toBeNull();
  });
});
