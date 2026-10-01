import {
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ProviderInteractionMode,
  ProviderOptionSelection,
  PreviewAnnotationPayloadSchema,
  RuntimeMode,
  ThreadId,
} from "@akeru/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { DraftThreadEnvModeSchema } from "./draftTypes";

export const PersistedComposerImageAttachment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  dataUrl: Schema.String,
});

export type PersistedComposerImageAttachment = typeof PersistedComposerImageAttachment.Type;

export const PersistedTerminalContextDraft = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  createdAt: Schema.String,
  terminalId: Schema.String,
  terminalLabel: Schema.String,
  lineStart: Schema.Number,
  lineEnd: Schema.Number,
});

export type PersistedTerminalContextDraft = typeof PersistedTerminalContextDraft.Type;

const PersistedElementContextStackFrame = Schema.Struct({
  functionName: Schema.NullOr(Schema.String),
  fileName: Schema.NullOr(Schema.String),
  lineNumber: Schema.NullOr(Schema.Number),
  columnNumber: Schema.NullOr(Schema.Number),
});

export const PersistedElementContextDraft = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  pickedAt: Schema.String,
  pageUrl: Schema.String,
  pageTitle: Schema.NullOr(Schema.String),
  tagName: Schema.String,
  selector: Schema.NullOr(Schema.String),
  htmlPreview: Schema.String,
  componentName: Schema.NullOr(Schema.String),
  source: Schema.NullOr(PersistedElementContextStackFrame),
  styles: Schema.String,
});

export type PersistedElementContextDraft = typeof PersistedElementContextDraft.Type;

export const PersistedComposerThreadDraftState = Schema.Struct({
  prompt: Schema.String,
  attachments: Schema.Array(PersistedComposerImageAttachment),
  terminalContexts: Schema.optionalKey(Schema.Array(PersistedTerminalContextDraft)),
  elementContexts: Schema.optionalKey(Schema.Array(PersistedElementContextDraft)),
  previewAnnotations: Schema.optionalKey(Schema.Array(PreviewAnnotationPayloadSchema)),
  // Keyed by `ProviderInstanceId` (open branded slug) so custom provider
  // instances (e.g. `codex_personal`) round-trip alongside the built-in
  // `codex` / `claudeAgent` / ... entries. Every prior `ProviderDriverKind`
  // literal satisfies the `ProviderInstanceId` slug pattern, so existing
  // persisted drafts decode unchanged.
  //
  // The record's value schema is NOT wrapped in `Schema.optionalKey`:
  // that helper is only meaningful on property signatures with a known
  // key set, and `Schema.Record(<branded string>, …)` produces an index
  // signature at runtime (Schema rejects the combination). Absence of
  // an entry already encodes "no selection for this instance".
  modelSelectionByProvider: Schema.optionalKey(Schema.Record(ProviderInstanceId, ModelSelection)),
  activeProvider: Schema.optionalKey(Schema.NullOr(ProviderInstanceId)),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
});

export type PersistedComposerThreadDraftState = typeof PersistedComposerThreadDraftState.Type;

/**
 * Per-provider record of generic option selections. Used as a transient
 * representation when migrating legacy v2 storage payloads and when
 * deriving per-provider option bundles for downstream consumers.
 */
export type ProviderOptionSelectionsByProvider = Partial<
  Record<string, ReadonlyArray<ProviderOptionSelection>>
>;

export type LegacyCodexFields = {
  effort?: unknown;
  codexFastMode?: unknown;
  serviceTier?: unknown;
};

type LegacyThreadModelFields = {
  provider?: unknown;
  model?: unknown;
  modelOptions?: unknown;
};

type LegacyV2ThreadDraftFields = {
  modelSelection?: ModelSelection | null;
  modelOptions?: unknown;
};

export type LegacyPersistedComposerThreadDraftState = PersistedComposerThreadDraftState &
  LegacyCodexFields &
  LegacyThreadModelFields &
  LegacyV2ThreadDraftFields;

type LegacyStickyModelFields = {
  stickyProvider?: unknown;
  stickyModel?: unknown;
  stickyModelOptions?: unknown;
};

type LegacyV2StoreFields = {
  stickyModelSelection?: ModelSelection | null;
  stickyModelOptions?: unknown;
  projectDraftThreadIdByProjectId?: Record<string, string> | null;
  draftsByThreadId?: Record<string, PersistedComposerThreadDraftState> | null;
  draftThreadsByThreadId?: Record<string, PersistedDraftThreadState> | null;
  projectDraftThreadIdByProjectKey?: Record<string, string> | null;
  draftsByThreadKey?: Record<string, PersistedComposerThreadDraftState> | null;
  draftThreadsByThreadKey?: Record<string, PersistedDraftThreadState> | null;
  projectDraftThreadKeyByProjectKey?: Record<string, string> | null;
  logicalProjectDraftThreadKeyByLogicalProjectKey?: Record<string, string> | null;
};

export type LegacyPersistedComposerDraftStoreState = PersistedComposerDraftStoreState &
  LegacyStickyModelFields &
  LegacyV2StoreFields;

export const PersistedDraftThreadState = Schema.Struct({
  threadId: ThreadId,
  environmentId: Schema.String,
  projectId: ProjectId,
  logicalProjectKey: Schema.optionalKey(Schema.String),
  createdAt: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  envMode: DraftThreadEnvModeSchema,
  startFromOrigin: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  promotedTo: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        environmentId: Schema.String,
        threadId: Schema.String,
      }),
    ),
  ),
});

export type PersistedDraftThreadState = typeof PersistedDraftThreadState.Type;

export const PersistedComposerDraftStoreState = Schema.Struct({
  draftsByThreadKey: Schema.Record(Schema.String, PersistedComposerThreadDraftState),
  draftThreadsByThreadKey: Schema.Record(Schema.String, PersistedDraftThreadState),
  logicalProjectDraftThreadKeyByLogicalProjectKey: Schema.Record(Schema.String, Schema.String),
  stickyModelSelectionByProvider: Schema.optionalKey(
    Schema.Record(ProviderInstanceId, ModelSelection),
  ),
  stickyActiveProvider: Schema.optionalKey(Schema.NullOr(ProviderInstanceId)),
});

export type PersistedComposerDraftStoreState = typeof PersistedComposerDraftStoreState.Type;

export const PersistedComposerDraftStoreStorage = Schema.Struct({
  version: Schema.Number,
  state: PersistedComposerDraftStoreState,
});

export const EMPTY_PERSISTED_DRAFT_STORE_STATE = Object.freeze<PersistedComposerDraftStoreState>({
  draftsByThreadKey: {},
  draftThreadsByThreadKey: {},
  logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  stickyModelSelectionByProvider: {},
  stickyActiveProvider: null,
});
