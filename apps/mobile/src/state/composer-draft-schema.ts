import {
  ModelSelection as ModelSelectionSchema,
  ProviderInteractionMode as ProviderInteractionModeSchema,
  RuntimeMode as RuntimeModeSchema,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@akeru/contracts";
import * as Schema from "effect/Schema";
import { DraftComposerImageAttachmentSchema } from "../lib/composer-image-schema";
import type { DraftComposerImageAttachment } from "../lib/composerImages";

export const COMPOSER_DRAFTS_SCHEMA_VERSION = 1;

export interface ComposerDraft {
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly importedShareIds?: ReadonlyArray<string>;
  readonly modelSelection?: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly workspaceSelection?: ComposerDraftWorkspaceSelection;
}

export interface ComposerDraftContent {
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly sourceShareId?: string;
}

export interface ComposerDraftWorkspaceSelection {
  readonly mode: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly startFromOrigin?: boolean;
}

export type ComposerDraftSettingsUpdate = Pick<
  ComposerDraft,
  "modelSelection" | "runtimeMode" | "interactionMode" | "workspaceSelection"
>;

const ComposerDraftWorkspaceSelectionSchema = Schema.Struct({
  mode: Schema.Literals(["local", "worktree"]),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  startFromOrigin: Schema.optional(Schema.Boolean),
});

const ComposerDraftSchema = Schema.Struct({
  text: Schema.String,
  attachments: Schema.Array(DraftComposerImageAttachmentSchema),
  importedShareIds: Schema.optional(Schema.Array(Schema.String)),
  modelSelection: Schema.optional(ModelSelectionSchema),
  runtimeMode: Schema.optional(RuntimeModeSchema),
  interactionMode: Schema.optional(ProviderInteractionModeSchema),
  workspaceSelection: Schema.optional(ComposerDraftWorkspaceSelectionSchema),
});

const PersistedComposerDraftsSchema = Schema.Struct({
  schemaVersion: Schema.Literal(COMPOSER_DRAFTS_SCHEMA_VERSION),
  drafts: Schema.Record(Schema.String, ComposerDraftSchema),
});

const decodePersistedComposerDraftsDocument = Schema.decodeUnknownSync(
  PersistedComposerDraftsSchema,
);

export const EMPTY_DRAFT: ComposerDraft = {
  text: "",
  attachments: [],
};

export function normalizeDraft(draft: ComposerDraft | undefined): ComposerDraft {
  if (!draft) {
    return EMPTY_DRAFT;
  }

  return {
    ...draft,
    text: draft.text,
    attachments: draft.attachments,
  };
}

export function isComposerDraftEmpty(draft: ComposerDraft): boolean {
  return isEmptyDraft(draft);
}

export function isEmptyDraft(draft: ComposerDraft): boolean {
  return (
    draft.text.length === 0 &&
    draft.attachments.length === 0 &&
    draft.modelSelection === undefined &&
    draft.runtimeMode === undefined &&
    draft.interactionMode === undefined &&
    draft.workspaceSelection === undefined
  );
}

export function decodePersistedComposerDrafts(value: unknown): Record<string, ComposerDraft> {
  const parsed = decodePersistedComposerDraftsDocument(value);

  return Object.fromEntries(
    Object.entries(parsed.drafts).filter(([, draft]) => !isEmptyDraft(draft)),
  );
}
