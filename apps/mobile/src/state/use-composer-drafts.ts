import { useAtomValue } from "@effect/atom-react";
import {
  ModelSelection as ModelSelectionSchema,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProviderInteractionMode as ProviderInteractionModeSchema,
  RuntimeMode as RuntimeModeSchema,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect } from "react";
import { Atom } from "effect/unstable/reactivity";

import { writeFileAtomically } from "../lib/atomic-file";
import { DraftComposerImageAttachmentSchema } from "../lib/composer-image-schema";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import { SerializedAsyncQueue } from "../lib/serialized-async-queue";
import { appAtomRegistry } from "./atom-registry";

const COMPOSER_DRAFTS_SCHEMA_VERSION = 1;
const COMPOSER_DRAFTS_DIRECTORY = "composer-drafts";
const COMPOSER_DRAFTS_FILE = "drafts.json";
const PERSIST_DEBOUNCE_MS = 200;

export class ComposerDraftPersistenceError extends Schema.TaggedErrorClass<ComposerDraftPersistenceError>()(
  "ComposerDraftPersistenceError",
  {
    operation: Schema.Literals(["open", "read", "decode", "encode", "write", "hydrate"]),
    directory: Schema.String,
    fileName: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Composer draft persistence operation ${this.operation} failed for ${this.directory}/${this.fileName}.`;
  }
}

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

const EMPTY_DRAFT: ComposerDraft = {
  text: "",
  attachments: [],
};

export const composerDraftsAtom = Atom.make<Record<string, ComposerDraft>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:composer-drafts"),
);

let loadPromise: Promise<void> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistRetryNeeded = false;
const persistenceQueue = new SerializedAsyncQueue();

/** Resets module-level state between test runs. */
export function resetComposerDraftsLoadState(): void {
  loadPromise = null;
  persistRetryNeeded = false;
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}

function normalizeDraft(draft: ComposerDraft | undefined): ComposerDraft {
  if (!draft) {
    return EMPTY_DRAFT;
  }
  return {
    ...draft,
    text: draft.text,
    attachments: draft.attachments,
  };
}

export function getComposerDraftSnapshot(draftKey: string): ComposerDraft {
  return normalizeDraft(appAtomRegistry.get(composerDraftsAtom)[draftKey]);
}

export function isComposerDraftEmpty(draft: ComposerDraft): boolean {
  return isEmptyDraft(draft);
}

function isEmptyDraft(draft: ComposerDraft): boolean {
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

async function getComposerDraftsFile() {
  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, COMPOSER_DRAFTS_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  return new File(directory, COMPOSER_DRAFTS_FILE);
}

async function loadPersistedComposerDrafts(): Promise<Record<string, ComposerDraft>> {
  let operation: ComposerDraftPersistenceError["operation"] = "open";
  try {
    const file = await getComposerDraftsFile();
    if (!file.exists) {
      return {};
    }
    operation = "read";
    const raw = await file.text();
    operation = "decode";
    return decodePersistedComposerDrafts(JSON.parse(raw) as unknown);
  } catch (cause) {
    throw new ComposerDraftPersistenceError({
      operation,
      directory: COMPOSER_DRAFTS_DIRECTORY,
      fileName: COMPOSER_DRAFTS_FILE,
      cause,
    });
  }
}

async function writePersistedComposerDrafts(drafts: Record<string, ComposerDraft>): Promise<void> {
  let operation: ComposerDraftPersistenceError["operation"] = "open";
  try {
    const file = await getComposerDraftsFile();
    operation = "encode";
    const nonEmptyDrafts = Object.fromEntries(
      Object.entries(drafts).filter(([, draft]) => !isEmptyDraft(draft)),
    );
    const document = {
      schemaVersion: COMPOSER_DRAFTS_SCHEMA_VERSION,
      drafts: nonEmptyDrafts,
    } as const;
    const encoded = JSON.stringify(document);
    operation = "write";
    await writeFileAtomically(file, encoded);
  } catch (cause) {
    throw new ComposerDraftPersistenceError({
      operation,
      directory: COMPOSER_DRAFTS_DIRECTORY,
      fileName: COMPOSER_DRAFTS_FILE,
      cause,
    });
  }
}

/**
 * Lands any debounced or in-flight draft write before the JS runtime is torn
 * down (app update restart), so the freshest draft state survives it. A write
 * failure propagates so the caller can decide whether the restart may proceed.
 */
export async function flushComposerDrafts(): Promise<void> {
  // Never land a pre-hydration snapshot: persisted state must merge into the
  // atoms first, or this write would clobber disk with partial data.
  ensureComposerDraftsLoaded();
  if (loadPromise !== null) {
    await loadPromise;
  }
  // An edit during an awaited write schedules another debounced write, so
  // keep landing snapshots until no debounce is pending after a queue drain.
  do {
    while (persistTimer !== null || persistRetryNeeded) {
      if (persistTimer !== null) clearTimeout(persistTimer);
      persistTimer = null;
      persistRetryNeeded = false;
      try {
        await persistenceQueue.run(() =>
          writePersistedComposerDrafts(appAtomRegistry.get(composerDraftsAtom)),
        );
      } catch (error) {
        persistRetryNeeded = true;
        throw error;
      }
    }
    // Draining also waits for an already-fired debounce whose write is still
    // gated behind its own hydration await inside the queue.
    await persistenceQueue.run(() => Promise.resolve());
  } while (persistTimer !== null || persistRetryNeeded);
}

function schedulePersistComposerDrafts(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    // The write enters the serialization queue before waiting on hydration,
    // so flushComposerDrafts' queue drain cannot resolve ahead of it.
    void persistenceQueue.run(async () => {
      try {
        await waitForComposerDraftsLoaded();
        await writePersistedComposerDrafts(appAtomRegistry.get(composerDraftsAtom));
        persistRetryNeeded = false;
      } catch (error) {
        // A failed debounce has no timer left. A later final flush must retry
        // these edits after persisted ownership can be read safely.
        persistRetryNeeded = true;
        console.warn("[composer-drafts] failed to persist drafts", error);
        // Draft persistence is best-effort; in-memory drafts still keep working.
      }
    });
  }, PERSIST_DEBOUNCE_MS);
}

export function ensureComposerDraftsLoaded(): void {
  if (loadPromise !== null) {
    return;
  }
  const loading = loadPersistedComposerDrafts().then((persistedDrafts) => {
    if (Object.keys(persistedDrafts).length === 0) {
      return;
    }
    const current = appAtomRegistry.get(composerDraftsAtom);
    appAtomRegistry.set(composerDraftsAtom, {
      ...persistedDrafts,
      ...current,
    });
  });
  loadPromise = loading;
  // Handle fire-and-forget hook loads without swallowing failures from the
  // write and cleanup callers that await this same promise. A later call retries.
  void loading.catch((cause) => {
    if (loadPromise === loading) loadPromise = null;
    console.warn(
      "[composer-drafts] failed to hydrate drafts",
      cause instanceof ComposerDraftPersistenceError
        ? cause
        : new ComposerDraftPersistenceError({
            operation: "hydrate",
            directory: COMPOSER_DRAFTS_DIRECTORY,
            fileName: COMPOSER_DRAFTS_FILE,
            cause,
          }),
    );
  });
}

/** Wait until persisted drafts have been merged into the in-memory composer state. */
export async function waitForComposerDraftsLoaded(): Promise<void> {
  ensureComposerDraftsLoaded();
  if (loadPromise !== null) {
    await loadPromise;
  }
}

function updateComposerDrafts(
  update: (current: Record<string, ComposerDraft>) => Record<string, ComposerDraft>,
): void {
  const current = appAtomRegistry.get(composerDraftsAtom);
  const next = update(current);
  if (next === current) {
    return;
  }
  appAtomRegistry.set(composerDraftsAtom, next);
  schedulePersistComposerDrafts();
}

export function setComposerDraftText(draftKey: string, value: string): void {
  updateComposerDrafts((current) => {
    const draft = {
      ...normalizeDraft(current[draftKey]),
      text: value,
    };
    if (isEmptyDraft(draft)) {
      const next = { ...current };
      delete next[draftKey];
      return next;
    }
    return {
      ...current,
      [draftKey]: draft,
    };
  });
}

export function appendComposerDraftText(draftKey: string, value: string): void {
  updateComposerDrafts((current) => {
    const existing = normalizeDraft(current[draftKey]);
    return {
      ...current,
      [draftKey]: {
        ...existing,
        text: `${existing.text}${value}`,
      },
    };
  });
}

export function appendComposerDraftAttachments(
  draftKey: string,
  attachments: ReadonlyArray<DraftComposerImageAttachment>,
): void {
  if (attachments.length === 0) {
    return;
  }
  updateComposerDrafts((current) => {
    const existing = normalizeDraft(current[draftKey]);
    return {
      ...current,
      [draftKey]: {
        ...existing,
        attachments: [...existing.attachments, ...attachments],
      },
    };
  });
}

export function replaceComposerDraftAttachments(
  draftKey: string,
  attachments: ReadonlyArray<DraftComposerImageAttachment>,
): void {
  updateComposerDrafts((current) => {
    const draft = {
      ...normalizeDraft(current[draftKey]),
      attachments,
    };
    if (isEmptyDraft(draft)) {
      const next = { ...current };
      delete next[draftKey];
      return next;
    }
    return {
      ...current,
      [draftKey]: draft,
    };
  });
}

export function removeComposerDraftAttachment(draftKey: string, imageId: string): void {
  updateComposerDrafts((current) => {
    const existing = normalizeDraft(current[draftKey]);
    const draft = {
      ...existing,
      attachments: existing.attachments.filter((image) => image.id !== imageId),
    };
    if (isEmptyDraft(draft)) {
      const next = { ...current };
      delete next[draftKey];
      return next;
    }
    return {
      ...current,
      [draftKey]: draft,
    };
  });
}

export function updateComposerDraftSettings(
  draftKey: string,
  settings: Partial<ComposerDraftSettingsUpdate>,
): void {
  updateComposerDrafts((current) => {
    const draft = {
      ...normalizeDraft(current[draftKey]),
      ...settings,
    };
    if (isEmptyDraft(draft)) {
      const next = { ...current };
      delete next[draftKey];
      return next;
    }
    return {
      ...current,
      [draftKey]: draft,
    };
  });
}

export function clearComposerDraftContentState(
  current: Record<string, ComposerDraft>,
  draftKey: string,
  options?: { readonly clearWorkspaceSelection?: boolean },
): Record<string, ComposerDraft> {
  const existing = current[draftKey];
  if (!existing) {
    return current;
  }
  const { importedShareIds: _importedShareIds, workspaceSelection, ...retained } = existing;
  const draft = {
    ...retained,
    ...(options?.clearWorkspaceSelection || workspaceSelection === undefined
      ? {}
      : { workspaceSelection }),
    text: "",
    attachments: [],
  };
  if (isEmptyDraft(draft)) {
    const next = { ...current };
    delete next[draftKey];
    return next;
  }
  return {
    ...current,
    [draftKey]: draft,
  };
}

export function restoreComposerDraftSnapshotState(
  current: Record<string, ComposerDraft>,
  draftKey: string,
  snapshot: ComposerDraft,
): Record<string, ComposerDraft> {
  const next = { ...current };
  if (isEmptyDraft(snapshot)) {
    delete next[draftKey];
  } else {
    next[draftKey] = snapshot;
  }
  return next;
}

export function copyComposerDraftContentState(
  current: Record<string, ComposerDraft>,
  sourceDraftKey: string,
  targetDraftKey: string,
): Record<string, ComposerDraft> {
  if (sourceDraftKey === targetDraftKey) {
    return current;
  }
  const source = normalizeDraft(current[sourceDraftKey]);
  const target = normalizeDraft(current[targetDraftKey]);
  const sourceHasContent =
    source.text.length > 0 ||
    source.attachments.length > 0 ||
    (source.importedShareIds?.length ?? 0) > 0;
  const targetHasContent =
    target.text.length > 0 ||
    target.attachments.length > 0 ||
    (target.importedShareIds?.length ?? 0) > 0;
  if (!sourceHasContent || targetHasContent) {
    return current;
  }
  return {
    ...current,
    [targetDraftKey]: {
      ...target,
      text: source.text,
      attachments: source.attachments,
      ...(source.importedShareIds ? { importedShareIds: source.importedShareIds } : {}),
    },
  };
}

export async function copyComposerDraftContentIfEmpty(
  sourceDraftKey: string,
  targetDraftKey: string,
): Promise<void> {
  await waitForComposerDraftsLoaded();
  updateComposerDrafts((current) =>
    copyComposerDraftContentState(current, sourceDraftKey, targetDraftKey),
  );
}

function mergeComposerDraftText(existing: string, incoming: string): string {
  if (incoming.length === 0) {
    return existing;
  }
  if (existing.length === 0) {
    return incoming;
  }
  // Import retries are possible after an interrupted native handoff. Keep the
  // operation idempotent when the same shared text is already present.
  if (existing === incoming || existing.endsWith(`\n\n${incoming}`)) {
    return existing;
  }
  return `${existing}\n\n${incoming}`;
}

export function mergeComposerDraftContentState(
  current: Record<string, ComposerDraft>,
  draftKey: string,
  content: ComposerDraftContent,
): Record<string, ComposerDraft> {
  const existing = normalizeDraft(current[draftKey]);
  if (content.sourceShareId && existing.importedShareIds?.includes(content.sourceShareId)) {
    return current;
  }
  const attachmentIds = new Set(existing.attachments.map((attachment) => attachment.id));
  const incomingAttachments = content.attachments.filter((attachment) => {
    if (attachmentIds.has(attachment.id)) {
      return false;
    }
    attachmentIds.add(attachment.id);
    return true;
  });
  const attachments = [...existing.attachments, ...incomingAttachments].slice(
    0,
    PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  );
  const text = mergeComposerDraftText(existing.text, content.text);
  const importedShareIds = content.sourceShareId
    ? [...(existing.importedShareIds ?? []), content.sourceShareId]
    : existing.importedShareIds;
  if (
    text === existing.text &&
    attachments.length === existing.attachments.length &&
    importedShareIds === existing.importedShareIds
  ) {
    return current;
  }
  return {
    ...current,
    [draftKey]: {
      ...existing,
      text,
      attachments,
      ...(importedShareIds ? { importedShareIds } : {}),
    },
  };
}

/**
 * Atomically moves an incoming share into a project-scoped composer draft.
 * The durable write happens before the share inbox item can be acknowledged.
 */
export async function mergeComposerDraftContent(
  draftKey: string,
  content: ComposerDraftContent,
): Promise<{ readonly skippedAttachmentCount: number }> {
  await waitForComposerDraftsLoaded();
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const current = appAtomRegistry.get(composerDraftsAtom);
  const next = mergeComposerDraftContentState(current, draftKey, content);
  const currentAttachmentIds = new Set(
    normalizeDraft(current[draftKey]).attachments.map((attachment) => attachment.id),
  );
  const nextAttachmentIds = new Set(
    normalizeDraft(next[draftKey]).attachments.map((attachment) => attachment.id),
  );
  const skippedAttachmentCount = content.attachments.filter(
    (attachment) =>
      !currentAttachmentIds.has(attachment.id) && !nextAttachmentIds.has(attachment.id),
  ).length;
  // Publish the content and its import receipt together before the filesystem
  // await. Typing during persistence then builds on the receipt-bearing state,
  // and its debounced write is serialized after this transaction.
  if (next !== current) {
    appAtomRegistry.set(composerDraftsAtom, next);
  }
  await persistenceQueue.run(() => writePersistedComposerDrafts(next));
  return { skippedAttachmentCount };
}

/** Restores the exact content/settings captured before an interrupted import. */
export async function restoreComposerDraftSnapshot(
  draftKey: string,
  snapshot: ComposerDraft,
): Promise<void> {
  await waitForComposerDraftsLoaded();
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const next = restoreComposerDraftSnapshotState(
    appAtomRegistry.get(composerDraftsAtom),
    draftKey,
    snapshot,
  );
  appAtomRegistry.set(composerDraftsAtom, next);
  await persistenceQueue.run(() => writePersistedComposerDrafts(next));
}

export function clearComposerDraftContent(
  draftKey: string,
  options?: { readonly clearWorkspaceSelection?: boolean },
): void {
  updateComposerDrafts((current) => clearComposerDraftContentState(current, draftKey, options));
}

export function clearComposerDraft(draftKey: string): void {
  updateComposerDrafts((current) => {
    if (!current[draftKey]) {
      return current;
    }
    const next = { ...current };
    delete next[draftKey];
    return next;
  });
}

export function removeComposerDraftsForEnvironment(
  drafts: Record<string, ComposerDraft>,
  environmentId: EnvironmentId,
): Record<string, ComposerDraft> {
  const environmentPrefix = `${environmentId}:`;
  const newTaskPrefix = `new-task:${environmentId}:`;
  return Object.fromEntries(
    Object.entries(drafts).filter(
      ([draftKey]) =>
        !draftKey.startsWith(environmentPrefix) && !draftKey.startsWith(newTaskPrefix),
    ),
  );
}

export async function clearComposerDraftsEnvironment(environmentId: EnvironmentId): Promise<void> {
  await waitForComposerDraftsLoaded();

  const next = removeComposerDraftsForEnvironment(
    appAtomRegistry.get(composerDraftsAtom),
    environmentId,
  );

  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  appAtomRegistry.set(composerDraftsAtom, next);
  await persistenceQueue.run(() => writePersistedComposerDrafts(next));
}

export function useComposerDraft(draftKey: string | null): ComposerDraft {
  const drafts = useAtomValue(composerDraftsAtom);
  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);
  return draftKey ? normalizeDraft(drafts[draftKey]) : EMPTY_DRAFT;
}
