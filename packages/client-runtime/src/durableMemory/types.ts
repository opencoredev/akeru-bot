import {
  type AkeruMemoryApprovalState,
  type AkeruMemoryArchiveTarget,
  type AkeruMemoryDeletionState,
  type AkeruMemoryScope,
} from "@akeru/contracts";
import {
  createTranslator,
  type MessageKey,
  type PluralForms,
  type TranslationParams,
} from "../i18n/index.ts";

/**
 * The part of a client translator the shared memory copy needs. Web and mobile pass the
 * translator from their language provider; plain code outside React may omit it for English.
 * Every label constant in this module is a catalog key, so callers render it with `t(label)`.
 */
export interface DurableMemoryTranslator {
  readonly t: (message: MessageKey, params?: TranslationParams) => string;
  readonly plural: (count: number, forms: PluralForms, params?: TranslationParams) => string;
}

export const englishTranslator: DurableMemoryTranslator = createTranslator("en");

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
