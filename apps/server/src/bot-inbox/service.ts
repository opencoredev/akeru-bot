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
  readonly acknowledgedAt?: string;
  // Provider-reported failure timestamp, when the caller knows it. Resolution
  // snapshots it so the same persisted failure cannot reopen a closed incident.
  readonly lastFailedRequestAt?: string;
  readonly resolvedFailureAt?: string;
  readonly occurrenceCount: number;
}

export type BotInboxIncident = Pick<
  BotInboxItem,
  | "incidentKey"
  | "kind"
  | "botId"
  | "botName"
  | "taskOrRoutine"
  | "lastFailure"
  | "nextAction"
  | "lastFailedRequestAt"
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

    const previous = this.items.findLast((item) => item.incidentKey === incident.incidentKey);
    const created: BotInboxItem = {
      id: NodeCrypto.randomUUID(),
      ...incident,
      status: "open",
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      occurrenceCount: (previous?.occurrenceCount ?? 0) + 1,
    };
    this.items.push(created);
    this.save();
    return created;
  }

  ensureOpen(incident: BotInboxIncident): BotInboxItem {
    this.reload();
    let existingIndex = this.items.findIndex(
      (item) => item.incidentKey === incident.incidentKey && item.status === "open",
    );
    if (existingIndex < 0) {
      existingIndex = this.items.findLastIndex(
        (item) => item.incidentKey === incident.incidentKey && item.acknowledgedAt !== undefined,
      );
    }
    if (existingIndex < 0) return this.upsert(incident);

    const existing = this.items[existingIndex]!;
    if (existing.status === "resolved") {
      // Reopen in place only when the reported failure is genuinely newer than
      // the one the item was closed against. Comparisons use provider failure
      // timestamps, never the local resolution time, so clock skew cannot hide
      // a new failure. Kinds that represent discrete lifecycle events
      // (browser-dead) carry no timestamp and always reopen; recurring kinds
      // (connector, approval, routine) must not resurrect on every sync.
      const failureAt = incident.lastFailedRequestAt;
      const storedFailureAt =
        existing.resolvedFailureAt ?? existing.lastFailedRequestAt ?? null;
      const timestampedReopenAllowed =
        incident.kind === "browser-dead" ||
        incident.kind === "silence-watchdog-failure";
      if (failureAt === undefined) {
        if (!timestampedReopenAllowed) return existing;
      } else if (storedFailureAt !== null) {
        if (failureAt <= storedFailureAt) return existing;
      } else {
        // Legacy rows carry no provider timestamp at all, so the first reported
        // failure is ambiguous: it may be the one the item was resolved on.
        // Adopt it as the baseline and reopen only on a strictly newer one.
        const baselined: BotInboxItem = {
          ...existing,
          resolvedFailureAt: failureAt,
        };
        this.items[existingIndex] = baselined;
        this.save();
        return baselined;
      }
      const {
        resolvedAt: _resolvedAt,
        acknowledgedAt: _acknowledgedAt,
        resolvedFailureAt: _resolvedFailureAt,
        ...active
      } = existing;
      const reopened: BotInboxItem = {
        ...active,
        ...incident,
        status: "open",
        lastSeenAt: this.now(),
        occurrenceCount: existing.occurrenceCount + 1,
      };
      this.items[existingIndex] = reopened;
      this.save();
      return reopened;
    }
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
      if (
        item.incidentKey !== incidentKey ||
        (item.status === "resolved" && item.acknowledgedAt === undefined)
      ) {
        return item;
      }
      changed = true;
      const { acknowledgedAt: _acknowledgedAt, ...resolvedItem } = item;
      return {
        ...resolvedItem,
        status: "resolved",
        resolvedAt,
        lastSeenAt: resolvedAt,
        ...(item.lastFailedRequestAt !== undefined
          ? { resolvedFailureAt: item.lastFailedRequestAt }
          : {}),
      };
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
      return {
        ...item,
        status: "resolved",
        resolvedAt,
        lastSeenAt: resolvedAt,
        acknowledgedAt: resolvedAt,
        ...(item.lastFailedRequestAt !== undefined
          ? { resolvedFailureAt: item.lastFailedRequestAt }
          : {}),
      };
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
