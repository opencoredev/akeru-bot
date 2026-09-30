import {
  AKERU_MEMORY_APPROVAL_REQUESTED_ACTIVITY,
  AKERU_MEMORY_APPROVAL_RESOLVED_ACTIVITY,
  AkeruMemoryApprovalRequest,
  AkeruMemoryDecisionReceipt,
  type AkeruMemoryApprovalState,
  type AkeruMemoryArchiveTarget,
  type AkeruMemoryArchiveV2,
  type AkeruMemoryDeletionState,
  type AkeruMemoryImportClassification,
  type AkeruMemoryImportPreview,
  type AkeruMemoryImportPreviewItem,
  type AkeruMemoryMutation,
  type AkeruMemoryRevision,
  type AkeruMemoryRootId,
  type AkeruMemoryScope,
  type AkeruMemoryTargetScope,
  type BotId,
  type SharedProjectMemorySaveMode,
  type ThreadId,
} from "@akeru/contracts";
import * as Schema from "effect/Schema";

import {
  createTranslator,
  type MessageKey,
  type PluralForms,
  type TranslationParams,
} from "./i18n/index.ts";

/**
 * The part of a client translator the shared memory copy needs. Web and mobile pass the
 * translator from their language provider; plain code outside React may omit it for English.
 * Every label constant in this module is a catalog key, so callers render it with `t(label)`.
 */
export interface DurableMemoryTranslator {
  readonly t: (message: MessageKey, params?: TranslationParams) => string;
  readonly plural: (count: number, forms: PluralForms, params?: TranslationParams) => string;
}

const englishTranslator: DurableMemoryTranslator = createTranslator("en");

/** Durable-archive scopes a client offers. Workspace stays internal to project-level memory. */
export type DurableMemoryExportScope = Exclude<AkeruMemoryArchiveTarget, "workspace">;

export const DURABLE_MEMORY_EXPORT_SCOPES: ReadonlyArray<{
  readonly scope: DurableMemoryExportScope;
  readonly label: MessageKey;
  readonly description: MessageKey;
}> = [
  { scope: "thread", label: "This chat", description: "Facts saved only for this chat." },
  { scope: "bot", label: "This bot", description: "Facts this bot keeps about you and its work." },
  { scope: "project", label: "This project", description: "Facts shared across this project." },
  {
    scope: "all",
    label: "All memory",
    description: "Everything this chat can reach. Export only; import one scope at a time.",
  },
];

/** Scopes durable facts can be inspected in. `all` is omitted because it reads every chat. */
export const DURABLE_MEMORY_INSPECT_SCOPES = DURABLE_MEMORY_EXPORT_SCOPES.filter(
  (option) => option.scope !== "all",
);

export const DURABLE_MEMORY_SCOPE_LABELS: Readonly<Record<AkeruMemoryScope, MessageKey>> = {
  user: "You",
  "bot-user": "Bot, about you",
  bot: "Bot",
  project: "Project",
  group: "Group",
  workspace: "Workspace",
  thread: "Chat",
};

export const DURABLE_MEMORY_APPROVAL_LABELS: Readonly<
  Record<AkeruMemoryApprovalState, MessageKey>
> = {
  pending: "Waiting for approval",
  approved: "Approved",
  rejected: "Rejected",
};

export const DURABLE_MEMORY_DELETION_LABELS: Readonly<
  Record<AkeruMemoryDeletionState, MessageKey>
> = {
  active: "Active",
  tombstoned: "Forgotten",
  deleted: "Deleted",
};

export const IMPORT_CLASSIFICATION_ORDER: ReadonlyArray<AkeruMemoryImportClassification> = [
  "conflicting",
  "new",
  "changed",
  "skipped",
];

export const IMPORT_CLASSIFICATION_LABELS: Readonly<
  Record<AkeruMemoryImportClassification, MessageKey>
> = {
  conflicting: "Conflicts",
  new: "New",
  changed: "Changed",
  skipped: "Skipped",
};

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

/**
 * Shared project memory has two modes, so every client shows it as one switch:
 * on saves automatically, off asks first.
 */
export const SHARED_PROJECT_MEMORY_SETTING: Readonly<Record<"label" | "description", MessageKey>> =
  {
    label: "Save shared project memory automatically",
    description: "When off, facts shared with a project wait for your approval.",
  };

export const sharedProjectMemoryAutoSaves = (mode: SharedProjectMemorySaveMode) => mode === "auto";

export const sharedProjectMemoryMode = (autoSave: boolean): SharedProjectMemorySaveMode =>
  autoSave ? "auto" : "ask";

/** Hint for memory settings that do nothing while Memory itself is off. */
export const MEMORY_SETTING_DISABLED_HINT: MessageKey = "Turn on Memory to change this.";

export type ImportConflictDecision = "keep-local" | "use-archive";

export interface DurableImportReviewItem extends AkeruMemoryImportPreviewItem {
  /** Current text of the archive chain for this root. */
  readonly archiveFact: string | null;
  /** Current local text, when the caller has loaded local facts for the same scope. */
  readonly localFact: string | null;
}

export function groupImportPreview(input: {
  readonly preview: AkeruMemoryImportPreview;
  readonly archive: AkeruMemoryArchiveV2;
  readonly localFacts?: ReadonlyArray<DurableMemoryFact>;
}): ReadonlyArray<{
  readonly classification: AkeruMemoryImportClassification;
  readonly items: ReadonlyArray<DurableImportReviewItem>;
}> {
  const archiveFacts = new Map(
    durableFactsFromArchive(input.archive).map((fact) => [fact.rootId, fact.fact]),
  );
  const localFacts = new Map((input.localFacts ?? []).map((fact) => [fact.rootId, fact.fact]));
  return IMPORT_CLASSIFICATION_ORDER.map((classification) => ({
    classification,
    items: input.preview.items
      .filter((item) => item.classification === classification)
      .map((item) => ({
        ...item,
        archiveFact: archiveFacts.get(item.rootId) ?? null,
        localFact: localFacts.get(item.rootId) ?? null,
      })),
  })).filter((group) => group.items.length > 0);
}

/**
 * Resolutions for an import apply request, or the conflicts still waiting for a choice.
 * There is no default decision: every conflict must be chosen before anything applies.
 */
export function resolveImportConflicts(
  preview: AkeruMemoryImportPreview,
  choices: Readonly<Record<string, ImportConflictDecision | undefined>>,
):
  | {
      readonly ready: true;
      readonly resolutions: ReadonlyArray<{
        readonly rootId: AkeruMemoryRootId;
        readonly decision: ImportConflictDecision;
      }>;
    }
  | { readonly ready: false; readonly unresolved: ReadonlyArray<AkeruMemoryRootId> } {
  const conflicts = preview.items.filter((item) => item.classification === "conflicting");
  const unresolved = conflicts.filter((item) => choices[item.rootId] === undefined);
  if (unresolved.length > 0) {
    return { ready: false, unresolved: unresolved.map((item) => item.rootId) };
  }
  return {
    ready: true,
    resolutions: conflicts.map((item) => ({
      rootId: item.rootId,
      decision: choices[item.rootId]!,
    })),
  };
}

/** Durable archives are schema version 2; bot-note archives are version 3. */
export function memoryArchiveSchemaVersion(value: unknown): number | null {
  if (typeof value !== "object" || value === null || !("schemaVersion" in value)) return null;
  return typeof value.schemaVersion === "number" ? value.schemaVersion : null;
}

export function durableMemoryExportFileName(scope: DurableMemoryExportScope, threadId: string) {
  return `akeru-durable-memory-${scope}-${threadId}.json`;
}

/** Approval card heading for each scope a pending fact would be saved to. */
export const MEMORY_APPROVAL_HEADINGS: Readonly<Record<AkeruMemoryTargetScope, MessageKey>> = {
  private: "Save to private memory?",
  bot: "Save to this bot's memory?",
  project: "Save to project memory?",
  group: "Save to group memory?",
  workspace: "Save to workspace memory?",
};

/** Inbox next-step line for each scope a pending fact would be saved to. */
export const MEMORY_APPROVAL_ACTIONS: Readonly<Record<AkeruMemoryTargetScope, MessageKey>> = {
  private: "Save to private memory",
  bot: "Save to this bot's memory",
  project: "Save to project memory",
  group: "Save to group memory",
  workspace: "Save to workspace memory",
};

export const memoryApprovalHeading = (
  scope: AkeruMemoryTargetScope,
  i18n: Pick<DurableMemoryTranslator, "t"> = englishTranslator,
) => i18n.t(MEMORY_APPROVAL_HEADINGS[scope]);

const isApprovalRequest = Schema.is(AkeruMemoryApprovalRequest);
const isDecisionReceipt = Schema.is(AkeruMemoryDecisionReceipt);

/**
 * Shared facts a bot asked to save in this chat that nobody has approved or
 * rejected yet, oldest first. Derived from thread activities, so the list
 * survives reloads and clears when either the chat card or the inbox decides.
 */
export function pendingMemoryApprovals(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
): ReadonlyArray<AkeruMemoryApprovalRequest> {
  const resolved = new Set<string>();
  for (const activity of activities) {
    if (
      activity.kind === AKERU_MEMORY_APPROVAL_RESOLVED_ACTIVITY &&
      isDecisionReceipt(activity.payload)
    ) {
      resolved.add(activity.payload.candidateId);
    }
  }
  const pending: AkeruMemoryApprovalRequest[] = [];
  const seen = new Set<string>();
  for (const activity of activities) {
    if (
      activity.kind !== AKERU_MEMORY_APPROVAL_REQUESTED_ACTIVITY ||
      !isApprovalRequest(activity.payload)
    ) {
      continue;
    }
    const request = activity.payload;
    if (resolved.has(request.candidateId) || seen.has(request.candidateId)) continue;
    seen.add(request.candidateId);
    pending.push(request);
  }
  return pending;
}

export type MemoryApprovalIntent =
  | { readonly action: "approve"; readonly fact?: string }
  | { readonly action: "reject" };

/** Builds the mutation that approves, edits and approves, or rejects a pending shared fact. */
export function memoryApprovalMutation(
  request: Pick<AkeruMemoryApprovalRequest, "candidateId" | "fact">,
  intent: MemoryApprovalIntent,
): AkeruMemoryMutation {
  if (intent.action === "reject") {
    return {
      operation: "candidate.decide",
      decision: { candidateId: request.candidateId, decision: "reject" },
    };
  }
  const edited = intent.fact?.trim();
  return {
    operation: "candidate.decide",
    decision: {
      candidateId: request.candidateId,
      decision: "approve",
      ...(edited && edited !== request.fact ? { fact: edited } : {}),
    },
  };
}
