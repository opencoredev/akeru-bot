import { useAtomValue } from "@effect/atom-react";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@akeru/contracts";
import { useEffect, useMemo } from "react";
import { Atom } from "effect/unstable/reactivity";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import { appAtomRegistry } from "./atom-registry";
import {
  type ComposerDraft,
  type ComposerDraftContent,
  type ComposerDraftSettingsUpdate,
  EMPTY_DRAFT,
  isEmptyDraft,
  normalizeDraft,
} from "./composer-draft-schema";
import {
  cancelScheduledComposerDraftsPersist,
  composerDraftsAtom,
  ensureComposerDraftsLoaded,
  updateComposerDrafts,
  waitForComposerDraftsLoaded,
  writeComposerDraftsNow,
} from "./composer-draft-persistence";

type ComposerDraftSettings = {
  readonly modelSelection: ModelSelection | undefined;
  readonly runtimeMode: RuntimeMode | undefined;
  readonly interactionMode: ProviderInteractionMode | undefined;
};

export { decodePersistedComposerDrafts, isComposerDraftEmpty } from "./composer-draft-schema";

export type {
  ComposerDraft,
  ComposerDraftContent,
  ComposerDraftSettingsUpdate,
  ComposerDraftWorkspaceSelection,
} from "./composer-draft-schema";

export {
  ComposerDraftPersistenceError,
  composerDraftsAtom,
  ensureComposerDraftsLoaded,
  flushComposerDrafts,
  getComposerDraftSnapshot,
  resetComposerDraftsLoadState,
  waitForComposerDraftsLoaded,
} from "./composer-draft-persistence";

// Per-key view of the draft map. The derived atom only notifies when this
// key's draft object changes, so typing in one chat does not re-render
// components that read another chat's draft.
const composerDraftAtom = Atom.family((draftKey: string) =>
  Atom.make((get): ComposerDraft | undefined => get(composerDraftsAtom)[draftKey]),
);

function composerDraftFieldAtomFamily<K extends keyof ComposerDraft>(field: K) {
  return Atom.family((draftKey: string) =>
    Atom.make((get): ComposerDraft[K] | undefined => get(composerDraftsAtom)[draftKey]?.[field]),
  );
}

// Draft edits spread the previous draft, so these references only change when
// the setting itself changes, not on every keystroke.
const composerDraftModelSelectionAtom = composerDraftFieldAtomFamily("modelSelection");

const composerDraftRuntimeModeAtom = composerDraftFieldAtomFamily("runtimeMode");

const composerDraftInteractionModeAtom = composerDraftFieldAtomFamily("interactionMode");

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
) {
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
) {
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
) {
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
) {
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
  cancelScheduledComposerDraftsPersist();
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

  await writeComposerDraftsNow(next);

  return { skippedAttachmentCount };
}

/** Restores the exact content/settings captured before an interrupted import. */
export async function restoreComposerDraftSnapshot(
  draftKey: string,
  snapshot: ComposerDraft,
): Promise<void> {
  await waitForComposerDraftsLoaded();
  cancelScheduledComposerDraftsPersist();

  const next = restoreComposerDraftSnapshotState(
    appAtomRegistry.get(composerDraftsAtom),
    draftKey,
    snapshot,
  );

  appAtomRegistry.set(composerDraftsAtom, next);
  await writeComposerDraftsNow(next);
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

  cancelScheduledComposerDraftsPersist();
  appAtomRegistry.set(composerDraftsAtom, next);
  await writeComposerDraftsNow(next);
}

export function useComposerDraft(draftKey: string | null): ComposerDraft {
  const draft = useAtomValue(composerDraftAtom(draftKey ?? ""));
  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);

  return useMemo(() => (draftKey ? normalizeDraft(draft) : EMPTY_DRAFT), [draft, draftKey]);
}

/** Reads a draft's settings without subscribing to its text or attachments. */
export function useComposerDraftSettings(draftKey: string | null): ComposerDraftSettings {
  const key = draftKey ?? "";
  const modelSelection = useAtomValue(composerDraftModelSelectionAtom(key));
  const runtimeMode = useAtomValue(composerDraftRuntimeModeAtom(key));
  const interactionMode = useAtomValue(composerDraftInteractionModeAtom(key));

  return { modelSelection, runtimeMode, interactionMode };
}
