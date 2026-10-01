import {
  type AkeruMemoryApprovalState,
  type AkeruMemoryArchiveV2,
  type AkeruMemoryDeletionState,
  type AkeruMemoryMutation,
  type AkeruMemoryRevision,
  type AkeruMemoryRootId,
  type AkeruMemoryScope,
  type AkeruMemoryTargetScope,
  type BotId,
  type ThreadId,
} from "@akeru/contracts";
import { type MessageKey } from "../i18n/index.ts";
import { type DurableMemoryTranslator, englishTranslator } from "./types.ts";

export interface DurableMemoryFact {
  readonly rootId: AkeruMemoryRootId;
  readonly fact: string;
  readonly scope: AkeruMemoryScope;
  readonly sourceThreadId: ThreadId | null;
  readonly affectedBotIds: ReadonlyArray<BotId>;
  readonly approvalState: AkeruMemoryApprovalState;
  readonly deletionState: AkeruMemoryDeletionState;
  readonly pinned: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
  /** The fact this revision replaced, when the chain has an earlier value. */
  readonly supersededFact: string | null;
}

/** Collapses archive revision chains into one current fact per root, newest update first. */
export function summarizeDurableFacts(
  revisions: ReadonlyArray<AkeruMemoryRevision>,
): ReadonlyArray<DurableMemoryFact> {
  const byId = new Map(revisions.map((revision) => [revision.id, revision]));
  const latest = new Map<AkeruMemoryRootId, AkeruMemoryRevision>();
  const first = new Map<AkeruMemoryRootId, AkeruMemoryRevision>();
  for (const revision of revisions) {
    const current = latest.get(revision.rootId);
    if (!current || revision.revision > current.revision) latest.set(revision.rootId, revision);
    const earliest = first.get(revision.rootId);
    if (!earliest || revision.revision < earliest.revision) first.set(revision.rootId, revision);
  }
  return (
    [...latest.values()]
      .map((revision) => {
        const previous = revision.supersedesId ? byId.get(revision.supersedesId) : undefined;
        return {
          rootId: revision.rootId,
          fact: revision.fact,
          scope: revision.partition.scope,
          sourceThreadId: revision.sourceThreadId,
          affectedBotIds: revision.affectedBotIds,
          approvalState: revision.approvalState,
          deletionState: revision.deletionState,
          pinned: revision.pinned,
          createdAt: first.get(revision.rootId)?.createdAt ?? revision.createdAt,
          updatedAt: revision.updatedAt,
          revision: revision.revision,
          supersededFact: previous && previous.fact !== revision.fact ? previous.fact : null,
        };
      })
      // .sort() on a copy, not .toSorted(): Hermes lacks ES2023 change-by-copy.
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  );
}

export function durableFactsFromArchive(archive: AkeruMemoryArchiveV2) {
  return summarizeDurableFacts(archive.revisions.map(({ revision }) => revision));
}

/** Where a fact can be moved, labeled as the action. Group and workspace scopes stay server-managed. */
export const DURABLE_FACT_MOVE_SCOPES: ReadonlyArray<{
  readonly scope: AkeruMemoryTargetScope;
  readonly label: MessageKey;
}> = [
  { scope: "private", label: "Make private" },
  { scope: "bot", label: "Move to this bot" },
  { scope: "project", label: "Share with project" },
];

const MOVE_SCOPE_BY_FACT_SCOPE: Partial<Record<AkeruMemoryScope, AkeruMemoryTargetScope>> = {
  "bot-user": "private",
  bot: "bot",
  project: "project",
};

/** Scopes the server refuses to move facts into while private bot memory is off. */
const BOT_PRIVATE_MOVE_SCOPES: ReadonlySet<AkeruMemoryTargetScope> = new Set(["private", "bot"]);

/** What the connected environment lets this client change. Mirrors the server's facts.mutate gates. */
export interface DurableFactPolicy {
  readonly canOperate: boolean;
  readonly memoryEnabled: boolean;
  readonly privateBotMemory: boolean;
}

/**
 * Move targets for one fact, without the scope it already lives in. Bot-private targets
 * drop out while private bot memory is off, because the server rejects those moves.
 */
export function durableFactMoveScopes(
  fact: Pick<DurableMemoryFact, "scope">,
  policy: Pick<DurableFactPolicy, "privateBotMemory">,
) {
  const current = MOVE_SCOPE_BY_FACT_SCOPE[fact.scope];
  return DURABLE_FACT_MOVE_SCOPES.filter(
    (option) =>
      option.scope !== current &&
      (policy.privateBotMemory || !BOT_PRIVATE_MOVE_SCOPES.has(option.scope)),
  );
}

/** Why a fact list offers no actions, or null when the client can change facts. */
export function durableFactReadOnlyReason(
  policy: Pick<DurableFactPolicy, "canOperate" | "memoryEnabled">,
): MessageKey | null {
  if (!policy.memoryEnabled) return "Memory is off. Turn it on in settings to change facts.";
  if (!policy.canOperate) return "This connection can read memory but not change it.";
  return null;
}

/** Names the chat a fact came from without exposing its id, or null when it has no source chat. */
export function durableFactSourceLabel(
  fact: Pick<DurableMemoryFact, "sourceThreadId">,
  input: {
    readonly currentThreadId: string | null;
    readonly threadTitles: ReadonlyMap<string, string>;
  },
  i18n: DurableMemoryTranslator = englishTranslator,
) {
  if (fact.sourceThreadId === null) return null;
  if (fact.sourceThreadId === input.currentThreadId) return i18n.t("this chat");
  return input.threadTitles.get(fact.sourceThreadId)?.trim() || i18n.t("another chat");
}

/** Names the bots a fact affects without exposing their ids, or null when it names none. */
export function durableFactBotsLabel(
  fact: Pick<DurableMemoryFact, "affectedBotIds">,
  input: {
    readonly currentBotId: string | null;
    readonly botNames: ReadonlyMap<string, string>;
  },
  i18n: DurableMemoryTranslator = englishTranslator,
): string | null {
  const labels: string[] = [];
  let unknown = 0;
  for (const botId of fact.affectedBotIds) {
    if (botId === input.currentBotId) labels.push(i18n.t("this bot"));
    else {
      const name = input.botNames.get(botId)?.trim();
      if (name) labels.push(name);
      else unknown += 1;
    }
  }
  if (unknown > 0) {
    labels.push(
      unknown === 1 ? i18n.t("another bot") : i18n.t("{count} other bots", { count: unknown }),
    );
  }
  return labels.length > 0 ? labels.join(i18n.t(", ")) : null;
}

/** Confirmation copy for permanently deleting a fact, shared by every client. */
export const DURABLE_FACT_DELETE_CONFIRM: Readonly<
  Record<"title" | "message" | "confirm" | "cancel", MessageKey>
> = {
  title: "Delete this fact for good?",
  message: "It can't be restored.",
  confirm: "Delete for good",
  cancel: "Keep",
};

export type DurableFactIntent =
  | { readonly action: "edit"; readonly fact: string }
  | { readonly action: "pin" }
  | { readonly action: "unpin" }
  | { readonly action: "move"; readonly scope: AkeruMemoryTargetScope }
  | { readonly action: "approve" }
  | { readonly action: "reject" }
  | { readonly action: "forget" }
  | { readonly action: "delete" };

export type DurableFactAction = DurableFactIntent["action"];

/**
 * Actions a fact offers in its current state. Forgotten facts only offer Delete because
 * forgetting has no undo on the server; the Forgotten status stays visible instead.
 */
export function durableFactActions(
  fact: Pick<DurableMemoryFact, "approvalState" | "deletionState" | "pinned" | "scope">,
  policy: DurableFactPolicy,
): ReadonlyArray<DurableFactAction> {
  if (durableFactReadOnlyReason(policy) !== null || fact.deletionState === "deleted") return [];
  if (fact.deletionState === "tombstoned") return ["delete"];
  const actions: DurableFactAction[] = ["edit", fact.pinned ? "unpin" : "pin"];
  if (durableFactMoveScopes(fact, policy).length > 0) actions.push("move");
  if (fact.approvalState === "pending") actions.push("approve", "reject");
  if (fact.approvalState === "rejected") actions.push("approve");
  actions.push("forget", "delete");
  return actions;
}

/** The mutation for one intent, pinned to the revision the user saw. */
export function durableFactMutation(
  fact: Pick<DurableMemoryFact, "rootId" | "revision">,
  intent: DurableFactIntent,
): AkeruMemoryMutation {
  const target = { memoryId: fact.rootId, expectedRevision: fact.revision };
  switch (intent.action) {
    case "edit":
      return { operation: "fact.edit", ...target, fact: intent.fact.trim() };
    case "pin":
    case "unpin":
      return { operation: "fact.pin", ...target, pinned: intent.action === "pin" };
    case "move":
      return { operation: "fact.scope", ...target, scope: intent.scope };
    case "approve":
    case "reject":
      return { operation: "fact.decide", ...target, decision: intent.action };
    case "forget":
      return { operation: "fact.forget", ...target };
    case "delete":
      return { operation: "fact.delete", ...target };
  }
}

/** Whether an edit draft can be saved: non-empty and different from the current text. */
export function canSaveDurableFactEdit(fact: Pick<DurableMemoryFact, "fact">, draft: string) {
  const next = draft.trim();
  return next.length > 0 && next !== fact.fact;
}

export const DURABLE_FACT_CONFLICT_MESSAGE: MessageKey =
  "This fact changed somewhere else. The latest version is shown now.";

/**
 * Plain copy for a failed fact mutation. `message` is a catalog key; `detail` is the raw
 * server text for failures without a stable meaning, shown as received next to it.
 * `conflict` tells the caller its copy is stale; the command already refreshes the lists,
 * so the latest version arrives on its own.
 */
export function describeDurableFactFailure(cause: unknown): {
  readonly conflict: boolean;
  readonly message: MessageKey;
  readonly detail: string | null;
} {
  const tag = typeof cause === "object" && cause !== null && "_tag" in cause ? cause._tag : null;
  if (tag === "EnvironmentAuthorizationError") {
    return {
      conflict: false,
      message: "This connection can read memory but not change it.",
      detail: null,
    };
  }
  const detail =
    typeof cause === "object" && cause !== null && "detail" in cause
      ? String(cause.detail)
      : cause instanceof Error
        ? cause.message
        : null;
  if (detail?.includes("revision conflict")) {
    return { conflict: true, message: DURABLE_FACT_CONFLICT_MESSAGE, detail: null };
  }
  return { conflict: false, message: "The fact could not be updated.", detail: detail || null };
}
