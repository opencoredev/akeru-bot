// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { BotId, type ProviderAccessStatus } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { ProviderStatus } from "../subscription-auth/service.ts";
import { syncAccessIncidents, syncConnectorIncidents } from "./connectorIncidents.ts";
import { BotInboxService } from "./service.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-incidents-"));
  directories.push(directory);
  return new BotInboxService(NodePath.join(directory, "bot-inbox.json"));
}

function status(
  health: ProviderStatus["health"],
  message = health === "failed-first-request" ? "The first request failed." : undefined,
): ProviderStatus {
  return {
    provider: "xai",
    connected: true,
    health,
    reconnectAction: "Reconnect account",
    healthTest: { status: "not-run" },
    dependentBots: [{ id: BotId.make("bot-akeru"), name: "Akeru" }],
    dependentRoutines: [],
    ...(message
      ? {
          lastFailedRequest: {
            at: "2026-08-30T20:00:00.000Z",
            message,
          },
        }
      : {}),
  };
}

describe("connector inbox incidents", () => {
  it.each([
    ["api-key-custom", "Custom API key"],
    ["grok-acp", "Grok ACP CLI"],
    ["mcp-builtin-executor", "Executor"],
  ])("opens an incident for failed %s access", (id, label) => {
    const inbox = fixture();
    const access: ProviderAccessStatus = {
      id,
      label,
      accessMethod: id.startsWith("mcp-") ? "mcp" : id.endsWith("-acp") ? "acp-cli" : "api-key",
      health: "failed-first-request",
      apiAccess: "not-applicable",
      nextAction: `Reconnect ${label}.`,
      lastFailedRequest: {
        at: "2026-08-30T20:00:00.000Z",
        message: `${label} rejected the request.`,
      },
      dependentBots: [{ id: BotId.make("bot-akeru"), name: "Akeru" }],
      dependentRoutines: [],
    };

    syncAccessIncidents(inbox, [access]);
    expect(inbox.list()[0]).toMatchObject({
      incidentKey: `access:${id}:bot-akeru`,
      status: "open",
      lastFailure: `${label} rejected the request.`,
    });

    syncAccessIncidents(inbox, [{ ...access, health: "recovered" }]);
    expect(inbox.list()[0]?.status).toBe("resolved");
  });

  it("opens once for a failed first request and does not count Settings reads", () => {
    const inbox = fixture();
    syncConnectorIncidents(inbox, [status("failed-first-request")]);
    syncConnectorIncidents(inbox, [status("failed-first-request")]);

    expect(inbox.list()).toEqual([
      expect.objectContaining({
        kind: "connector-failure",
        status: "open",
        occurrenceCount: 1,
        lastFailure: "The first request failed.",
      }),
    ]);
  });

  it("does not duplicate subscription failures as access incidents", () => {
    const inbox = fixture();
    const failed = status("failed-first-request");
    syncConnectorIncidents(inbox, [failed]);
    syncAccessIncidents(inbox, [
      {
        id: "xai-subscription",
        label: "xAI subscription login",
        accessMethod: "subscription-oauth",
        health: failed.health,
        apiAccess: "separate",
        nextAction: "Reconnect account.",
        lastFailedRequest: failed.lastFailedRequest,
        dependentBots: failed.dependentBots,
        dependentRoutines: [],
      },
    ]);

    expect(inbox.list()).toHaveLength(1);
    expect(inbox.list()[0]?.incidentKey).toBe("connector:xai:bot-akeru");
  });

  it("resolves the incident after reconnect or a recovered request", () => {
    const inbox = fixture();
    syncConnectorIncidents(inbox, [status("expired")]);
    syncConnectorIncidents(inbox, [status("detected")]);
    expect(inbox.list()[0]?.status).toBe("resolved");

    syncConnectorIncidents(inbox, [status("failed-first-request")]);
    syncConnectorIncidents(inbox, [status("recovered")]);
    expect(inbox.list().filter((item) => item.status === "open")).toHaveLength(0);
  });

  it("resolves the incident when the dependent bot is removed", () => {
    const inbox = fixture();
    syncConnectorIncidents(inbox, [status("failed")]);
    syncConnectorIncidents(inbox, [{ ...status("failed"), dependentBots: [] }]);

    expect(inbox.list()[0]?.status).toBe("resolved");
  });

  it("resolves the incident when the provider status is removed", () => {
    const inbox = fixture();
    syncConnectorIncidents(inbox, [status("failed")]);
    syncConnectorIncidents(inbox, []);

    expect(inbox.list()[0]?.status).toBe("resolved");
  });

  it.each([
    ["expired", "oauth-expired"],
    ["revoked", "connector-failure"],
    ["failed", "connector-failure"],
    ["failed-first-request", "connector-failure"],
  ] as const)("maps %s access to a %s incident", (health, kind) => {
    const inbox = fixture();
    syncConnectorIncidents(inbox, [status(health)]);
    expect(inbox.list()[0]?.kind).toBe(kind);
  });

  it("refreshes failure details without duplicating a connector incident", () => {
    const inbox = fixture();
    syncConnectorIncidents(inbox, [status("failed", "The request timed out.")]);
    syncConnectorIncidents(inbox, [status("failed", "The account lost access.")]);

    expect(inbox.list()).toEqual([
      expect.objectContaining({
        occurrenceCount: 1,
        lastFailure: "The account lost access.",
      }),
    ]);
  });
});
