import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import { preflightProvider } from "./providerPreflight.ts";

const provider: ServerProvider = {
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
  ],
  slashCommands: [],
  skills: [],
};

const failedAt = "2026-09-30T12:00:00.000Z";
const at = (offsetMs: number) => Date.parse(failedAt) + offsetMs;

const preflightAfterFailure = (
  message: string,
  options: { readonly model?: string; readonly now: number; readonly nextRetryAt?: string },
) =>
  preflightProvider({
    providers: [provider],
    providerId: "codex",
    model: options.model ?? "gpt-new",
    now: options.now,
    subscriptionHealth: () => ({
      health: "failed",
      lastFailedRequest: { at: failedAt, message },
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

  it("still blocks on a recorded login failure", () => {
    expect(preflightAfterFailure("Refresh token expired", { now: at(60 * 60_000) })?.category).toBe(
      "expired-login",
    );
  });
});
