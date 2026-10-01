import {
  type EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ProviderInteractionMode,
  ProviderDriverKind,
  ProviderOptionSelection,
  type PreviewAnnotationPayload,
  RuntimeMode,
  type ScopedProjectRef,
  type ScopedThreadRef,
  ThreadId,
} from "@akeru/contracts";
import * as Schema from "effect/Schema";
import { type ChatImageAttachment } from "../types";
import { type TerminalContextDraft } from "../lib/terminalContext";
import { type ElementContextDraft, type ElementContextSelection } from "../lib/elementContext";
import {
  type PersistedComposerImageAttachment,
  type ProviderOptionSelectionsByProvider,
} from "./draftPersistenceSchemas";

export const isRuntimeMode = Schema.is(RuntimeMode);

export const DraftThreadEnvModeSchema = Schema.Literals(["local", "worktree"]);

export type DraftThreadEnvMode = typeof DraftThreadEnvModeSchema.Type;

export const DraftId = Schema.String.pipe(Schema.brand("DraftId"));

export type DraftId = typeof DraftId.Type;

export interface ComposerImageAttachment extends Omit<ChatImageAttachment, "previewUrl"> {
  previewUrl: string;
  file: File;
}

/**
 * Composer content keyed by either a draft session (`DraftId`) or a real server
 * thread (`ScopedThreadRef`). This is the editable payload shown in the composer.
 */
export interface ComposerThreadDraftState {
  prompt: string;
  images: ComposerImageAttachment[];
  nonPersistedImageIds: string[];
  persistedAttachments: PersistedComposerImageAttachment[];
  terminalContexts: TerminalContextDraft[];
  /**
   * Element-pick attachments captured from the in-app preview browser. The
   * full payload (selector / html / styles / source frame) is persisted
   * inline because — unlike terminal contexts — there's no live session to
   * re-derive the snapshot from on reload.
   */
  elementContexts: ElementContextDraft[];
  previewAnnotations: PreviewAnnotationPayload[];
  /**
   * Per-instance model selection. Keyed by `ProviderInstanceId` (open
   * branded slug) so a default `codex` instance and a user-authored
   * `codex_personal` instance each persist their own selected model. Every
   * historical `ProviderDriverKind` literal (`codex` / `claudeAgent` /
   * `opencode`) also satisfies the `ProviderInstanceId` slug pattern, so
   * legacy kind-keyed drafts round-trip unchanged.
   */
  modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  /** Routing key of the last picked instance (see `modelSelectionByProvider`). */
  activeProvider: ProviderInstanceId | null;
  runtimeMode: RuntimeMode | null;
  interactionMode: ProviderInteractionMode | null;
}

/**
 * True when the user has invested real content in the draft: typed text or
 * any attachment/context. Model selection and mode choices alone do not
 * count — those are ambient defaults, not work in progress. Used by the
 * sidebar draft rows (which draft sessions deserve a row) and by new-thread
 * resurrection (a draft with content keeps its settings instead of being
 * reset to defaults).
 */
export function composerDraftHasUserContent(
  draft: ComposerThreadDraftState | null | undefined,
): boolean {
  if (!draft) {
    return false;
  }

  return (
    draft.prompt.trim().length > 0 ||
    draft.images.length > 0 ||
    draft.persistedAttachments.length > 0 ||
    draft.terminalContexts.length > 0 ||
    draft.elementContexts.length > 0 ||
    draft.previewAnnotations.length > 0
  );
}

/**
 * Mutable routing and execution context for a pre-thread draft session.
 *
 * Unlike a real server thread, a draft session can still change target
 * environment/worktree configuration before the first send.
 */
export interface DraftSessionState {
  threadId: ThreadId;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  logicalProjectKey: string;
  createdAt: string;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  branch: string | null;
  worktreePath: string | null;
  envMode: DraftThreadEnvMode;
  startFromOrigin: boolean;
  promotedTo?: ScopedThreadRef | null;
}

export type DraftThreadState = DraftSessionState;

/**
 * Draft session metadata paired with its stable draft-session identity.
 */
export interface ProjectDraftSession extends DraftSessionState {
  draftId: DraftId;
}

/**
 * App-facing composer identity:
 * - `DraftId` for pre-thread draft sessions
 * - `ScopedThreadRef` for server-backed threads
 *
 * Raw `ThreadId` is intentionally excluded so callers cannot drop environment
 * identity for real threads.
 */
export type ComposerThreadTarget = ScopedThreadRef | DraftId;

/**
 * Persisted store for composer content plus draft-session metadata.
 *
 * The store intentionally models two domains:
 * - draft sessions keyed by `DraftId`
 * - server thread composer state keyed by `ScopedThreadRef`
 */
export interface ComposerDraftStoreState {
  draftsByThreadKey: Record<string, ComposerThreadDraftState>;
  draftThreadsByThreadKey: Record<string, DraftThreadState>;
  logicalProjectDraftThreadKeyByLogicalProjectKey: Record<string, string>;
  backgroundSubmissionThreadKeys: Record<string, true>;
  stickyModelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  stickyActiveProvider: ProviderInstanceId | null;
  /** Returns the editable composer content for a draft session or server thread. */
  getComposerDraft: (target: ComposerThreadTarget) => ComposerThreadDraftState | null;
  /** Looks up the active draft session for a logical project identity. */
  getDraftThreadByLogicalProjectKey: (logicalProjectKey: string) => ProjectDraftSession | null;
  getDraftSessionByLogicalProjectKey: (logicalProjectKey: string) => ProjectDraftSession | null;
  getDraftThreadByProjectRef: (projectRef: ScopedProjectRef) => ProjectDraftSession | null;
  getDraftSessionByProjectRef: (projectRef: ScopedProjectRef) => ProjectDraftSession | null;
  /** Reads mutable draft-session metadata by `DraftId`. */
  getDraftSession: (draftId: DraftId) => DraftSessionState | null;
  /** Resolves a server-thread ref back to a matching draft session when one exists. */
  getDraftSessionByRef: (threadRef: ScopedThreadRef) => DraftSessionState | null;
  getDraftThreadByRef: (threadRef: ScopedThreadRef) => DraftThreadState | null;
  getDraftThread: (threadRef: ComposerThreadTarget) => DraftThreadState | null;
  listDraftThreadKeys: () => string[];
  hasDraftThreadsInEnvironment: (environmentId: EnvironmentId) => boolean;
  /** Creates or updates the draft session tracked for a logical project. */
  setLogicalProjectDraftThreadId: (
    logicalProjectKey: string,
    projectRef: ScopedProjectRef,
    draftId: DraftId,
    options?: {
      threadId?: ThreadId;
      branch?: string | null | undefined;
      worktreePath?: string | null | undefined;
      createdAt?: string;
      envMode?: DraftThreadEnvMode | undefined;
      startFromOrigin?: boolean;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
    },
  ) => void;
  /** Creates or updates the draft session tracked for a concrete project ref. */
  setProjectDraftThreadId: (
    projectRef: ScopedProjectRef,
    draftId: DraftId,
    options?: {
      threadId?: ThreadId;
      branch?: string | null | undefined;
      worktreePath?: string | null | undefined;
      createdAt?: string;
      envMode?: DraftThreadEnvMode | undefined;
      startFromOrigin?: boolean;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
    },
  ) => void;
  /** Updates mutable draft-session metadata without touching composer content. */
  setDraftThreadContext: (
    threadRef: ComposerThreadTarget,
    options: {
      branch?: string | null | undefined;
      worktreePath?: string | null | undefined;
      projectRef?: ScopedProjectRef;
      createdAt?: string;
      envMode?: DraftThreadEnvMode | undefined;
      startFromOrigin?: boolean;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
    },
  ) => void;
  clearProjectDraftThreadId: (projectRef: ScopedProjectRef) => void;
  clearProjectDraftThreadById: (
    projectRef: ScopedProjectRef,
    threadRef: ComposerThreadTarget,
  ) => void;
  /** Marks a draft session as being promoted to a real server thread. */
  markDraftThreadPromoting: (threadRef: ComposerThreadTarget, promotedTo?: ScopedThreadRef) => void;
  /** Removes draft-session metadata after promotion is complete. */
  finalizePromotedDraftThread: (threadRef: ComposerThreadTarget) => void;
  clearDraftThread: (threadRef: ComposerThreadTarget) => void;
  setStickyModelSelection: (modelSelection: ModelSelection | null | undefined) => void;
  setPrompt: (threadRef: ComposerThreadTarget, prompt: string) => void;
  setTerminalContexts: (threadRef: ComposerThreadTarget, contexts: TerminalContextDraft[]) => void;
  setModelSelection: (
    threadRef: ComposerThreadTarget,
    modelSelection: ModelSelection | null | undefined,
    opts?: {
      /**
       * Replace the stored entry outright instead of preserving its
       * existing options when the incoming selection has none. Used when
       * the selection is a complete snapshot (e.g. carried from another
       * thread) rather than a model-only change.
       */
      replaceOptions?: boolean;
    },
  ) => void;
  /** Replace the model options for one or more providers in the draft. */
  setModelOptions: (
    threadRef: ComposerThreadTarget,
    modelOptions:
      | Partial<Record<string, ReadonlyArray<ProviderOptionSelection>>>
      | null
      | undefined,
  ) => void;
  applyStickyState: (threadRef: ComposerThreadTarget) => void;
  setProviderModelOptions: (
    threadRef: ComposerThreadTarget,
    provider: ProviderDriverKind,
    nextProviderOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
    options?: {
      instanceId?: ProviderInstanceId | null | undefined;
      model?: string | null | undefined;
      persistSticky?: boolean;
    },
  ) => void;
  setRuntimeMode: (
    threadRef: ComposerThreadTarget,
    runtimeMode: RuntimeMode | null | undefined,
  ) => void;
  addImage: (threadRef: ComposerThreadTarget, image: ComposerImageAttachment) => void;
  addImages: (threadRef: ComposerThreadTarget, images: ComposerImageAttachment[]) => void;
  removeImage: (threadRef: ComposerThreadTarget, imageId: string) => void;
  insertTerminalContext: (
    threadRef: ComposerThreadTarget,
    prompt: string,
    context: TerminalContextDraft,
    index: number,
  ) => boolean;
  addTerminalContext: (threadRef: ComposerThreadTarget, context: TerminalContextDraft) => void;
  addTerminalContexts: (threadRef: ComposerThreadTarget, contexts: TerminalContextDraft[]) => void;
  removeTerminalContext: (threadRef: ComposerThreadTarget, contextId: string) => void;
  clearTerminalContexts: (threadRef: ComposerThreadTarget) => void;
  /**
   * Append a fresh element pick to the draft. Returns true when accepted,
   * false when deduped against an existing pick of the same element.
   */
  addElementContext: (
    threadRef: ComposerThreadTarget,
    selection: ElementContextSelection,
  ) => boolean;
  /**
   * Replace the entire element-contexts list (used by send-failure retry to
   * restore the pre-send snapshot).
   */
  setElementContexts: (
    threadRef: ComposerThreadTarget,
    contexts: ReadonlyArray<ElementContextDraft>,
  ) => void;
  removeElementContext: (threadRef: ComposerThreadTarget, contextId: string) => void;
  clearElementContexts: (threadRef: ComposerThreadTarget) => void;
  addPreviewAnnotation: (
    threadRef: ComposerThreadTarget,
    annotation: PreviewAnnotationPayload,
  ) => void;
  setPreviewAnnotations: (
    threadRef: ComposerThreadTarget,
    annotations: ReadonlyArray<PreviewAnnotationPayload>,
  ) => void;
  removePreviewAnnotation: (threadRef: ComposerThreadTarget, annotationId: string) => void;
  clearPersistedAttachments: (threadRef: ComposerThreadTarget) => void;
  syncPersistedAttachments: (
    threadRef: ComposerThreadTarget,
    attachments: PersistedComposerImageAttachment[],
  ) => void;
  clearComposerContent: (threadRef: ComposerThreadTarget) => void;
  /**
   * Clears only the prompt text and image attachments, preserving terminal /
   * element contexts and preview annotations. Used by the
   * prompt stash, which can only round-trip text + images: clearing the
   * session-bound contexts would destroy state nothing can restore.
   */
  clearComposerPromptAndImages: (threadRef: ComposerThreadTarget) => void;
  /**
   * Moves the prompt text and image attachments from one composer target to
   * another. Used when a draft changes project: the new project gets its own
   * draft session and the typed content follows it. Session-bound extras
   * (terminal / element contexts, preview annotations) stay
   * on the source — they reference sessions of the source thread that the
   * destination cannot use.
   */
  moveComposerPromptAndImages: (from: ComposerThreadTarget, to: ComposerThreadTarget) => void;
}

export interface EffectiveComposerModelState {
  selectedModel: string;
  modelOptions: ProviderOptionSelectionsByProvider | null;
}

export interface ComposerDraftModelState {
  activeProvider: ProviderInstanceId | null;
  modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
}

export const EMPTY_IMAGES: ComposerImageAttachment[] = [];

export const EMPTY_IDS: string[] = [];

export const EMPTY_PERSISTED_ATTACHMENTS: PersistedComposerImageAttachment[] = [];

const EMPTY_TERMINAL_CONTEXTS: TerminalContextDraft[] = [];

export const EMPTY_ELEMENT_CONTEXTS: ElementContextDraft[] = [];

export const EMPTY_PREVIEW_ANNOTATIONS: PreviewAnnotationPayload[] = [];

const EMPTY_MODEL_SELECTION_BY_PROVIDER: Partial<Record<ProviderDriverKind, ModelSelection>> =
  Object.freeze({});

export const EMPTY_COMPOSER_DRAFT_MODEL_STATE = Object.freeze<ComposerDraftModelState>({
  activeProvider: null,
  modelSelectionByProvider: EMPTY_MODEL_SELECTION_BY_PROVIDER,
});

export const EMPTY_THREAD_DRAFT = Object.freeze<ComposerThreadDraftState>({
  prompt: "",
  images: EMPTY_IMAGES,
  nonPersistedImageIds: EMPTY_IDS,
  persistedAttachments: EMPTY_PERSISTED_ATTACHMENTS,
  terminalContexts: EMPTY_TERMINAL_CONTEXTS,
  elementContexts: EMPTY_ELEMENT_CONTEXTS,
  previewAnnotations: EMPTY_PREVIEW_ANNOTATIONS,
  modelSelectionByProvider: EMPTY_MODEL_SELECTION_BY_PROVIDER,
  activeProvider: null,
  runtimeMode: null,
  interactionMode: null,
});

/**
 * Canonical factory for a blank `ComposerThreadDraftState`. Exported so tests
 * (and any other call sites) can build a draft without re-declaring every
 * slice — adding a new field to the interface (e.g. `elementContexts`) only
 * has to be reflected here, not in every stub.
 */
export function createEmptyThreadDraft(): ComposerThreadDraftState {
  return {
    prompt: "",
    images: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    terminalContexts: [],
    elementContexts: [],
    previewAnnotations: [],
    modelSelectionByProvider: {},
    activeProvider: null,
    runtimeMode: null,
    interactionMode: null,
  };
}
