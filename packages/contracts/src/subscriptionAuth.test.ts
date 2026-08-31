import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  SubscriptionAuthLoginProgress,
  SubscriptionAuthStartResult,
  SubscriptionAuthStatuses,
} from "./subscriptionAuth.ts";

const decodeStatuses = Schema.decodeUnknownSync(SubscriptionAuthStatuses);
const decodeStartResult = Schema.decodeUnknownSync(SubscriptionAuthStartResult);
const decodeLoginProgress = Schema.decodeUnknownSync(SubscriptionAuthLoginProgress);

describe("subscription auth contracts", () => {
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
