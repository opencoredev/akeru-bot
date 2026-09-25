import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  SubscriptionAuthLoginProgress,
  SubscriptionAuthStartResult,
  SubscriptionAuthStartInput,
  SubscriptionAuthStatuses,
} from "./subscriptionAuth.ts";

const decodeStartInput = Schema.decodeUnknownSync(SubscriptionAuthStartInput);
const decodeStatuses = Schema.decodeUnknownSync(SubscriptionAuthStatuses);
const decodeStartResult = Schema.decodeUnknownSync(SubscriptionAuthStartResult);
const decodeLoginProgress = Schema.decodeUnknownSync(SubscriptionAuthLoginProgress);

describe("subscription auth contracts", () => {
  it("accepts API-key setup and preserves the legacy OAuth input", () => {
    const decode = Schema.decodeUnknownSync(SubscriptionAuthStartInput);
    expect(decode({ provider: "anthropic" })).toEqual({ provider: "anthropic" });
    expect(
      decode({ provider: "anthropic", authMode: "api-key", baseUrl: "https://proxy.example/v1" }),
    ).toEqual({ provider: "anthropic", authMode: "api-key", baseUrl: "https://proxy.example/v1" });
  });

  it.each([
    "file:///tmp/key",
    "https://user:secret@example.com/v1",
    "https://example.com?key=secret",
    "https://example.com/#secret",
    "not-a-url",
  ])("rejects an unsafe base URL: %s", (baseUrl) => {
    expect(() =>
      decodeStartInput({
        provider: "anthropic",
        authMode: "api-key",
        baseUrl,
      }),
    ).toThrow();
  });

  it("decodes inbox items with and without a memory approval", () => {
    const item = {
      id: "item-1",
      incidentKey: "approval:request-1",
      kind: "approval-request",
      status: "open",
      botId: "bot-1",
      botName: "Ada",
      taskOrRoutine: "Planning",
      lastFailure: "This request needs approval.",
      nextAction: "Open the chat.",
      firstSeenAt: "2026-09-01T00:00:00.000Z",
      lastSeenAt: "2026-09-01T00:00:00.000Z",
      occurrenceCount: 1,
    };
    const memoryApproval = {
      candidateId: "candidate-1",
      fact: "The project uses Bun.",
      scope: "project",
      sensitive: false,
      sourceThreadId: "thread-1",
      authorBotId: "bot-1",
      affectedBotIds: ["bot-1"],
    };
    const decoded = decodeStatuses({
      providers: [],
      inbox: [item, { ...item, id: "item-2", memoryApproval }],
    });
    expect(decoded.inbox[0]?.memoryApproval).toBeUndefined();
    expect(decoded.inbox[1]?.memoryApproval).toEqual(memoryApproval);
  });

  it("exposes API-key metadata but strips secrets from status", () => {
    const decoded = decodeStatuses({
      providers: [
        {
          provider: "anthropic",
          connected: true,
          authMode: "api-key",
          baseUrl: "http://localhost:8080/v1",
          access: "secret",
          apiKey: "secret",
          refresh: "secret",
        },
      ],
    });
    expect(decoded.providers[0]).toMatchObject({
      authMode: "api-key",
      baseUrl: "http://localhost:8080/v1",
    });
    expect(JSON.stringify(decoded)).not.toContain("secret");
  });
  it("decodes provider statuses without any credential fields", () => {
    const decoded = decodeStatuses({
      providers: [{ provider: "openai-codex", connected: true, expiresAt: 123 }],
    });
    expect(decoded.providers[0]).toEqual({
      provider: "openai-codex",
      connected: true,
      expiresAt: 123,
      dependentBots: [],
      dependentRoutines: [],
    });
  });

  it("decodes every access-health state and action-required inbox data", () => {
    const healthStates = [
      "missing",
      "detected",
      "healthy",
      "expired",
      "revoked",
      "failed",
      "unsupported",
      "failed-first-request",
      "recovered",
    ] as const;
    for (const health of healthStates) {
      expect(
        decodeStatuses({
          providers: [{ provider: "xai", connected: true, health }],
          access: [
            {
              id: `access-${health}`,
              label: "Temporary email browser",
              accessMethod: "browser",
              health,
              apiAccess: "not-applicable",
              nextAction: "Use an email connector.",
              temporary: true,
              repairAction: "Add an email connector, then reconnect it.",
            },
          ],
          inbox: [
            {
              id: `incident-${health}`,
              incidentKey: `connector:xai:${health}`,
              kind: "connector-failure",
              status: "open",
              botId: "bot-akeru",
              botName: "Akeru",
              taskOrRoutine: "Morning research",
              lastFailure: "The provider request failed.",
              nextAction: "Reconnect the provider.",
              firstSeenAt: "2026-08-30T20:00:00.000Z",
              lastSeenAt: "2026-08-30T20:00:00.000Z",
              occurrenceCount: 1,
            },
          ],
        }).access[0],
      ).toMatchObject({ health, temporary: true });
    }
  });

  it("decodes the optional health-checking flag", () => {
    expect(
      decodeStatuses({
        providers: [
          {
            provider: "kimi-for-coding",
            connected: true,
            health: "detected",
            healthChecking: true,
          },
        ],
      }).providers[0],
    ).toMatchObject({ health: "detected", healthChecking: true });
    expect(
      decodeStatuses({ providers: [{ provider: "xai", connected: true, health: "healthy" }] })
        .providers[0],
    ).not.toHaveProperty("healthChecking");
  });

  it("decodes a remote-safe device login", () => {
    expect(
      decodeStartResult({
        loginId: "login-1",
        provider: "xai",
        url: "https://auth.x.ai/device",
        userCode: "ABCD-EFGH",
        completion: "poll",
      }),
    ).toMatchObject({ provider: "xai", completion: "poll" });
  });

  it("strips credential-shaped fields from progress", () => {
    const decoded = decodeLoginProgress({
      status: "connected",
      access: "must-not-cross-the-wire",
    });
    expect(decoded).toEqual({ status: "connected" });
    expect("access" in decoded).toBe(false);
  });
});
