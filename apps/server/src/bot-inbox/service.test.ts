// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { BotId } from "@t3tools/contracts";
import { BOT_INBOX_KINDS, BotInboxService } from "./service.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

function makeService(times: readonly string[]) {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-bot-inbox-"));
  directories.push(directory);
  const remaining = [...times];
  const filePath = NodePath.join(directory, `${NodeCrypto.randomUUID()}.json`);
  return {
    filePath,
    service: new BotInboxService(filePath, () => remaining.shift() ?? times.at(-1)!),
  };
}

const incident = {
  incidentKey: "connector:xai:bot-akeru",
  kind: "connector-failure" as const,
  botId: BotId.make("bot-akeru"),
  botName: "Akeru",
  taskOrRoutine: "Morning research",
  lastFailure: "Grok rejected the first ACP request.",
  nextAction: "Reconnect Grok in Settings.",
};

describe("bot inbox incidents", () => {
  it("accepts every action-required event kind", () => {
    expect(BOT_INBOX_KINDS).toEqual([
      "oauth-expired",
      "connector-failure",
      "routine-failure",
      "browser-dead",
      "silence-watchdog-failure",
      "approval-request",
    ]);
    for (const kind of BOT_INBOX_KINDS) {
      const { service } = makeService(["2026-08-30T20:00:00.000Z"]);
      expect(service.upsert({ ...incident, incidentKey: `kind:${kind}`, kind }).kind).toBe(kind);
    }
  });

  it("deduplicates an open incident and keeps the latest failure", () => {
    const { service } = makeService(["2026-08-30T20:00:00.000Z", "2026-08-30T20:01:00.000Z"]);
    const first = service.upsert(incident);
    const second = service.upsert({ ...incident, lastFailure: "OAuth was revoked." });

    expect(second.id).toBe(first.id);
    expect(second.occurrenceCount).toBe(2);
    expect(second.lastFailure).toBe("OAuth was revoked.");
    expect(service.list()).toHaveLength(1);
  });

  it("does not count a Settings snapshot as another occurrence", () => {
    const { service } = makeService(["2026-08-30T20:00:00.000Z", "2026-08-30T20:01:00.000Z"]);
    const first = service.ensureOpen(incident);
    const second = service.ensureOpen(incident);

    expect(second.id).toBe(first.id);
    expect(second.occurrenceCount).toBe(1);
    expect(second.lastSeenAt).toBe("2026-08-30T20:00:00.000Z");
  });

  it("resolves on recovery and opens a new incident after a later failure", () => {
    const { filePath, service } = makeService([
      "2026-08-30T20:00:00.000Z",
      "2026-08-30T20:02:00.000Z",
      "2026-08-30T20:03:00.000Z",
    ]);
    const first = service.upsert(incident);
    expect(service.resolve(incident.incidentKey)).toBe(true);
    const next = service.upsert(incident);

    expect(next.id).not.toBe(first.id);
    expect(service.list().map((item) => item.status)).toEqual(["open", "resolved"]);
    expect(new BotInboxService(filePath).list()).toHaveLength(2);
  });

  it("preserves incidents written by another service instance", () => {
    const { filePath, service: approvalWriter } = makeService([
      "2026-08-30T20:00:00.000Z",
      "2026-08-30T20:01:00.000Z",
    ]);
    const connectorWriter = new BotInboxService(filePath, () => "2026-08-30T20:02:00.000Z");

    approvalWriter.upsert({
      ...incident,
      incidentKey: "approval:request-1",
      kind: "approval-request",
    });
    connectorWriter.ensureOpen(incident);

    expect(new BotInboxService(filePath).list().map((item) => item.incidentKey)).toEqual([
      incident.incidentKey,
      "approval:request-1",
    ]);
  });
});
