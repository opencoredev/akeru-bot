// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { BotId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { ProviderStatus } from "../subscription-auth/service.ts";
import { syncConnectorIncidents } from "./connectorIncidents.ts";
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

  it("resolves the incident after reconnect or a recovered request", () => {
    const inbox = fixture();
    syncConnectorIncidents(inbox, [status("expired")]);
    syncConnectorIncidents(inbox, [status("detected")]);
    expect(inbox.list()[0]?.status).toBe("resolved");

    syncConnectorIncidents(inbox, [status("failed-first-request")]);
    syncConnectorIncidents(inbox, [status("recovered")]);
    expect(inbox.list().filter((item) => item.status === "open")).toHaveLength(0);
  });

  it("keeps an acknowledged failure closed until the connector recovers", () => {
    const inbox = fixture();
    syncConnectorIncidents(inbox, [status("failed")]);
    const first = inbox.list()[0]!;
    inbox.resolveById(first.id);

    syncConnectorIncidents(inbox, [status("failed")]);
    expect(inbox.list().filter((item) => item.status === "open")).toHaveLength(0);

    syncConnectorIncidents(inbox, [status("recovered")]);
    syncConnectorIncidents(inbox, [status("failed")]);
    const reopened = inbox.list().find((item) => item.status === "open");
    expect(reopened?.id).not.toBe(first.id);
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
    const first = inbox.list()[0]!;
    inbox.resolveById(first.id);
    syncConnectorIncidents(inbox, []);
    syncConnectorIncidents(inbox, [status("failed")]);

    expect(inbox.list().find((item) => item.status === "open")?.id).not.toBe(first.id);
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
