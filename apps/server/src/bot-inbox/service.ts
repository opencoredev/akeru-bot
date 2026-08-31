// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { BotId } from "@t3tools/contracts";

export const BOT_INBOX_KINDS = [
  "oauth-expired",
  "connector-failure",
  "routine-failure",
  "browser-dead",
  "silence-watchdog-failure",
  "approval-request",
] as const;

export type BotInboxKind = (typeof BOT_INBOX_KINDS)[number];

export interface BotInboxItem {
  readonly id: string;
  readonly incidentKey: string;
  readonly kind: BotInboxKind;
  readonly status: "open" | "resolved";
  readonly botId: BotId;
  readonly botName: string;
  readonly taskOrRoutine: string;
  readonly lastFailure: string;
  readonly nextAction: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly resolvedAt?: string;
  readonly occurrenceCount: number;
}

export type BotInboxIncident = Pick<
  BotInboxItem,
  "incidentKey" | "kind" | "botId" | "botName" | "taskOrRoutine" | "lastFailure" | "nextAction"
>;

export class BotInboxService {
  private items: BotInboxItem[] = [];
  private readonly filePath: string;
  private readonly now: () => string;

  constructor(filePath: string, now: () => string = () => new Date().toISOString()) {
    this.filePath = filePath;
    this.now = now;
    this.reload();
  }

  static forSecretsDir(secretsDir: string): BotInboxService {
    return new BotInboxService(NodePath.join(secretsDir, "bot-inbox.json"));
  }

  reload(): void {
    if (!NodeFS.existsSync(this.filePath)) {
      this.items = [];
      return;
    }
    try {
      const decoded = JSON.parse(NodeFS.readFileSync(this.filePath, "utf-8")) as BotInboxItem[];
      this.items = Array.isArray(decoded) ? decoded : [];
    } catch {
      this.items = [];
    }
  }

  list(): ReadonlyArray<BotInboxItem> {
    return [...this.items].sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
  }

  upsert(incident: BotInboxIncident): BotInboxItem {
    this.reload();
    const seenAt = this.now();
    const existingIndex = this.items.findIndex(
      (item) => item.incidentKey === incident.incidentKey && item.status === "open",
    );
    if (existingIndex >= 0) {
      const existing = this.items[existingIndex]!;
      const updated: BotInboxItem = {
        ...existing,
        ...incident,
        lastSeenAt: seenAt,
        occurrenceCount: existing.occurrenceCount + 1,
      };
      this.items[existingIndex] = updated;
      this.save();
      return updated;
    }

    const created: BotInboxItem = {
      id: NodeCrypto.randomUUID(),
      ...incident,
      status: "open",
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      occurrenceCount: 1,
    };
    this.items.push(created);
    this.save();
    return created;
  }

  ensureOpen(incident: BotInboxIncident): BotInboxItem {
    this.reload();
    const existingIndex = this.items.findIndex(
      (item) => item.incidentKey === incident.incidentKey && item.status === "open",
    );
    if (existingIndex < 0) return this.upsert(incident);

    const existing = this.items[existingIndex]!;
    if (
      existing.kind === incident.kind &&
      existing.botId === incident.botId &&
      existing.botName === incident.botName &&
      existing.taskOrRoutine === incident.taskOrRoutine &&
      existing.lastFailure === incident.lastFailure &&
      existing.nextAction === incident.nextAction
    ) {
      return existing;
    }

    const updated = {
      ...existing,
      ...incident,
      lastSeenAt: this.now(),
    };
    this.items[existingIndex] = updated;
    this.save();
    return updated;
  }

  resolve(incidentKey: string): boolean {
    this.reload();
    const resolvedAt = this.now();
    let changed = false;
    this.items = this.items.map((item) => {
      if (item.incidentKey !== incidentKey || item.status === "resolved") return item;
      changed = true;
      return { ...item, status: "resolved", resolvedAt, lastSeenAt: resolvedAt };
    });
    if (changed) this.save();
    return changed;
  }

  resolveById(id: string): boolean {
    this.reload();
    const resolvedAt = this.now();
    let changed = false;
    this.items = this.items.map((item) => {
      if (item.id !== id || item.status === "resolved") return item;
      changed = true;
      return { ...item, status: "resolved", resolvedAt, lastSeenAt: resolvedAt };
    });
    if (changed) this.save();
    return changed;
  }

  private save(): void {
    const directory = NodePath.dirname(this.filePath);
    NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${NodeCrypto.randomUUID()}.tmp`;
    NodeFS.writeFileSync(temporaryPath, JSON.stringify(this.items, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    NodeFS.renameSync(temporaryPath, this.filePath);
    NodeFS.chmodSync(this.filePath, 0o600);
  }
}
