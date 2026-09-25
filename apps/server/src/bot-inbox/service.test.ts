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

  it("reopens one silent-turn item across repeated silent windows", () => {
    const { service } = makeService([
      "2026-08-30T20:00:00.000Z",
      "2026-08-30T20:02:00.000Z",
      "2026-08-30T20:04:00.000Z",
    ]);
    const silence = {
      ...incident,
      incidentKey: "silence:thread-1:turn-1",
      kind: "silence-watchdog-failure" as const,
    };
    const first = service.ensureOpen(silence);
    service.resolve(silence.incidentKey);
    const second = service.ensureOpen(silence);

    expect(second.id).toBe(first.id);
    expect(second.status).toBe("open");
    expect(second.occurrenceCount).toBe(2);
    expect(service.list()).toHaveLength(1);
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
    expect(next.occurrenceCount).toBe(2);
    expect(new BotInboxService(filePath).list()).toHaveLength(2);
  });

  it("does not reopen for the same failure timestamp it was resolved against", () => {
    const { service } = makeService([
      "2026-08-30T20:00:00.000Z",
      "2026-08-30T20:01:00.000Z",
      "2026-08-30T20:02:00.000Z",
    ]);
    const failing = {
      ...incident,
      lastFailedRequestAt: "2026-08-30T20:00:00.000Z",
    };
    service.ensureOpen(failing);
    const item = service.list()[0]!;

    expect(service.resolveById(item.id)).toBe(true);
    service.ensureOpen(failing);

    expect(service.list()).toEqual([expect.objectContaining({ id: item.id, status: "resolved" })]);
  });

  it("reopens an acknowledged incident when a newer failure arrives", () => {
    const { service } = makeService([
      "2026-08-30T20:00:00.000Z",
      "2026-08-30T20:01:00.000Z",
      "2026-08-30T20:02:00.000Z",
      "2026-08-30T20:03:00.000Z",
    ]);
    service.ensureOpen({ ...incident, lastFailedRequestAt: "2026-08-30T20:00:00.000Z" });
    const item = service.list()[0]!;
    service.resolveById(item.id);

    const reopened = service.ensureOpen({
      ...incident,
      lastFailedRequestAt: "2026-08-30T20:02:00.000Z",
      lastFailure: "Grok rejected the second ACP request.",
    });

    expect(reopened.id).toBe(item.id);
    expect(reopened.status).toBe("open");
    expect(reopened.occurrenceCount).toBe(2);
    expect(reopened.lastFailure).toBe("Grok rejected the second ACP request.");
    expect(reopened.resolvedAt).toBeUndefined();
  });

  it("stays resolved after a repeated failure message with a newer timestamp", () => {
    const { service } = makeService([
      "2026-08-30T20:00:00.000Z",
      "2026-08-30T20:01:00.000Z",
      "2026-08-30T20:02:00.000Z",
      "2026-08-30T20:03:00.000Z",
    ]);
    service.ensureOpen({ ...incident, lastFailedRequestAt: "2026-08-30T20:00:00.000Z" });
    // Same message, newer provider failure while the item is still open.
    service.ensureOpen({ ...incident, lastFailedRequestAt: "2026-08-30T20:01:00.000Z" });
    const item = service.list()[0]!;
    service.resolveById(item.id);

    service.ensureOpen({ ...incident, lastFailedRequestAt: "2026-08-30T20:01:00.000Z" });

    expect(service.list()).toEqual([expect.objectContaining({ id: item.id, status: "resolved" })]);
  });

  it("stays resolved when the sync carries no failure timestamp", () => {
    const { service } = makeService([
      "2026-08-30T20:00:00.000Z",
      "2026-08-30T20:01:00.000Z",
      "2026-08-30T20:02:00.000Z",
    ]);
    service.ensureOpen(incident);
    const item = service.list()[0]!;

    expect(service.resolveById(item.id)).toBe(true);
    service.ensureOpen(incident);

    expect(service.list()).toEqual([expect.objectContaining({ id: item.id, status: "resolved" })]);
  });

  it("reopens through resolveById when a newer failure timestamp arrives", () => {
    const { service } = makeService([
      "2026-08-30T20:00:00.000Z",
      "2026-08-30T20:01:00.000Z",
      "2026-08-30T20:02:00.000Z",
    ]);
    service.ensureOpen({ ...incident, lastFailedRequestAt: "2026-08-30T20:00:00.000Z" });
    const item = service.list()[0]!;
    service.resolveById(item.id);

    service.ensureOpen({ ...incident, lastFailedRequestAt: "2026-08-30T20:00:00.000Z" });
    expect(service.list()[0]?.status).toBe("resolved");

    service.ensureOpen({ ...incident, lastFailedRequestAt: "2026-08-30T20:01:30.000Z" });
    expect(service.list()[0]).toEqual(
      expect.objectContaining({ id: item.id, status: "open", occurrenceCount: 2 }),
    );
  });

  it("reopens a skewed provider failure that is newer than the stored failure", () => {
    const { service } = makeService([
      "2026-08-30T20:00:00.000Z",
      "2026-08-30T20:01:00.000Z",
      "2026-08-30T20:02:00.000Z",
    ]);
    service.ensureOpen({ ...incident, lastFailedRequestAt: "2026-08-30T20:00:00.000Z" });
    const item = service.list()[0]!;
    // Local resolution clock runs ahead of the provider's failure timestamps.
    service.resolveById(item.id);

    const reopened = service.ensureOpen({
      ...incident,
      lastFailedRequestAt: "2026-08-30T20:00:30.000Z",
    });

    expect(reopened.id).toBe(item.id);
    expect(reopened.status).toBe("open");
    expect(reopened.occurrenceCount).toBe(2);
  });

  it("baselines a resolved legacy item on its first timestamped failure", () => {
    const { filePath, service } = makeService([
      "2026-08-30T20:00:00.000Z",
      "2026-08-30T20:01:00.000Z",
      "2026-08-30T20:02:00.000Z",
      "2026-08-30T20:03:00.000Z",
    ]);
    service.ensureOpen(incident);
    const item = service.list()[0]!;
    service.resolveById(item.id);

    // Simulate a record written before failure timestamps existed.
    const legacy = service
      .list()
      .map(({ lastFailedRequestAt: _f, resolvedFailureAt: _r, ...rest }) => rest);
    NodeFS.writeFileSync(filePath, JSON.stringify(legacy));

    // The first timestamped report is the failure it was resolved against:
    // record the baseline and keep the incident closed.
    const baselined = service.ensureOpen({
      ...incident,
      lastFailedRequestAt: "2026-08-30T20:00:00.000Z",
    });
    expect(baselined.status).toBe("resolved");
    expect(baselined.resolvedFailureAt).toBe("2026-08-30T20:00:00.000Z");

    // A strictly newer failure is genuinely new and reopens it.
    const reopened = service.ensureOpen({
      ...incident,
      lastFailedRequestAt: "2026-08-30T20:02:00.000Z",
    });
    expect(reopened.id).toBe(item.id);
    expect(reopened.status).toBe("open");
    expect(reopened.occurrenceCount).toBe(2);
  });

  it("reopens a resolved browser-dead incident for a new death", () => {
    const { service } = makeService([
      "2026-08-30T20:00:00.000Z",
      "2026-08-30T20:01:00.000Z",
      "2026-08-30T20:02:00.000Z",
    ]);
    const dead = {
      ...incident,
      incidentKey: "browser:bot-akeru",
      kind: "browser-dead" as const,
      lastFailure: "The managed browser exited.",
    };
    service.ensureOpen(dead);
    const item = service.list()[0]!;
    service.resolveById(item.id);

    const reopened = service.ensureOpen({
      ...dead,
      lastFailure: "The managed browser exited again.",
    });

    expect(reopened.id).toBe(item.id);
    expect(reopened.status).toBe("open");
    expect(reopened.occurrenceCount).toBe(2);
    expect(reopened.lastFailure).toBe("The managed browser exited again.");
  });

  it("resolves an open incident by id", () => {
    const { service } = makeService(["2026-08-30T20:00:00.000Z", "2026-08-30T20:01:00.000Z"]);
    const item = service.upsert(incident);

    expect(service.resolveById(item.id)).toBe(true);
    expect(service.list()[0]?.status).toBe("resolved");
    expect(service.resolveById(item.id)).toBe(false);
  });

  it("resolves only the incident with the matching id", () => {
    const { filePath, service } = makeService([
      "2026-08-30T20:00:00.000Z",
      "2026-08-30T20:01:00.000Z",
    ]);
    const item = service.upsert(incident);
    NodeFS.writeFileSync(filePath, JSON.stringify([item, { ...item, id: "replacement-incident" }]));

    expect(service.resolveById(item.id)).toBe(true);
    expect(service.list().map(({ id, status }) => ({ id, status }))).toEqual([
      { id: item.id, status: "resolved" },
      { id: "replacement-incident", status: "open" },
    ]);
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
