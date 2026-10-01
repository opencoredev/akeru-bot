import { type SharedProjectMemorySaveMode } from "@akeru/contracts";
import { type MessageKey } from "./i18n/index.ts";

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
export {
  type DurableMemoryTranslator,
  type DurableMemoryExportScope,
  DURABLE_MEMORY_EXPORT_SCOPES,
  DURABLE_MEMORY_INSPECT_SCOPES,
  DURABLE_MEMORY_SCOPE_LABELS,
  DURABLE_MEMORY_APPROVAL_LABELS,
  DURABLE_MEMORY_DELETION_LABELS,
} from "./durableMemory/types.ts";
export {
  IMPORT_CLASSIFICATION_ORDER,
  IMPORT_CLASSIFICATION_LABELS,
  type ImportConflictDecision,
  type DurableImportReviewItem,
  groupImportPreview,
  resolveImportConflicts,
  memoryArchiveSchemaVersion,
  durableMemoryExportFileName,
} from "./durableMemory/import.ts";
export {
  type DurableMemoryFact,
  summarizeDurableFacts,
  durableFactsFromArchive,
  DURABLE_FACT_MOVE_SCOPES,
  type DurableFactPolicy,
  durableFactMoveScopes,
  durableFactReadOnlyReason,
  durableFactSourceLabel,
  durableFactBotsLabel,
  DURABLE_FACT_DELETE_CONFIRM,
  type DurableFactIntent,
  type DurableFactAction,
  durableFactActions,
  durableFactMutation,
  canSaveDurableFactEdit,
  DURABLE_FACT_CONFLICT_MESSAGE,
  describeDurableFactFailure,
} from "./durableMemory/facts.ts";
export {
  MEMORY_APPROVAL_HEADINGS,
  MEMORY_APPROVAL_ACTIONS,
  memoryApprovalHeading,
  pendingMemoryApprovals,
  type MemoryApprovalIntent,
  memoryApprovalMutation,
} from "./durableMemory/approvals.ts";
