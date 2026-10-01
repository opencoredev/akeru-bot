import {
  DEFAULT_LOCAL_EXECUTION_MODE,
  type EnvironmentId,
  ProviderInteractionMode,
  RuntimeMode,
  type ScopedProjectRef,
  type ScopedThreadRef,
  ThreadId,
} from "@akeru/contracts";
import {
  parseScopedThreadKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@akeru/client-runtime/environment";
import { DEFAULT_INTERACTION_MODE } from "../types";
import {
  type DraftThreadEnvMode,
  DraftId,
  type ComposerDraftStoreState,
  type ComposerThreadTarget,
  type ComposerThreadDraftState,
  type DraftSessionState,
  type ProjectDraftSession,
  type DraftThreadState,
} from "./draftTypes";
import { revokeDraftThreadPreviewUrls } from "./draftContent";

export function normalizeDraftThreadEnvMode(
  value: unknown,
  fallbackWorktreePath: string | null,
): DraftThreadEnvMode {
  if (value === "local" || value === "worktree") {
    return value;
  }

  return fallbackWorktreePath ? "worktree" : "local";
}

export function projectDraftKey(projectRef: ScopedProjectRef): string {
  return scopedProjectKey(projectRef);
}

export function logicalProjectDraftKey(logicalProjectKey: string): string {
  return logicalProjectKey.trim();
}

/**
 * Runtime composer storage key for app-facing identities only.
 *
 * Draft sessions are keyed by `DraftId`. Real threads are keyed by
 * `ScopedThreadRef` so environment identity is always preserved.
 */
function composerTargetKey(target: ScopedThreadRef | DraftId): string {
  if (typeof target === "string") {
    return target.trim();
  }

  return scopedThreadKey(target);
}

/**
 * Legacy persisted data may still be keyed by a raw `ThreadId`. This helper is
 * intentionally migration-only so live code cannot accidentally accept that
 * incomplete identity.
 */
export function normalizeLegacyComposerStorageKey(
  threadKeyOrId: string,
  options?: {
    environmentId?: EnvironmentId;
  },
): string {
  const parsedThreadRef = parseScopedThreadKey(threadKeyOrId);

  if (parsedThreadRef) {
    return composerTargetKey(parsedThreadRef);
  }

  if (options?.environmentId) {
    return composerTargetKey(scopeThreadRef(options.environmentId, threadKeyOrId as ThreadId));
  }

  return threadKeyOrId;
}

export function composerThreadRefFromKey(threadKey: string): ScopedThreadRef | null {
  return parseScopedThreadKey(threadKey);
}

type ComposerThreadLookupState = Pick<
  ComposerDraftStoreState,
  "draftsByThreadKey" | "draftThreadsByThreadKey"
>;

function normalizeComposerTarget(
  state: ComposerThreadLookupState,
  target: ComposerThreadTarget,
): ComposerThreadTarget | null {
  if (typeof target === "string") {
    const draftId = target.trim();

    return draftId.length > 0 ? DraftId.make(draftId) : null;
  }

  return target;
}

export function resolveComposerDraftKey(
  state: ComposerThreadLookupState,
  target: ComposerThreadTarget,
): string | null {
  const normalizedTarget = normalizeComposerTarget(state, target);

  if (!normalizedTarget) {
    return null;
  }

  if (typeof normalizedTarget !== "string") {
    const scopedKey = composerTargetKey(normalizedTarget);

    if (state.draftsByThreadKey[scopedKey]) {
      return scopedKey;
    }

    for (const [draftId, draftSession] of Object.entries(state.draftThreadsByThreadKey)) {
      if (
        draftSession.environmentId === normalizedTarget.environmentId &&
        draftSession.threadId === normalizedTarget.threadId
      ) {
        return draftId;
      }
    }

    return scopedKey;
  }

  const threadKey = composerTargetKey(normalizedTarget);

  return threadKey.length > 0 ? threadKey : null;
}

export function resolveComposerThreadId(
  state: ComposerThreadLookupState,
  target: ComposerThreadTarget,
): ThreadId | null {
  const normalizedTarget = normalizeComposerTarget(state, target);

  if (!normalizedTarget) {
    return null;
  }

  if (typeof normalizedTarget !== "string") {
    return normalizedTarget.threadId;
  }

  return state.draftThreadsByThreadKey[normalizedTarget]?.threadId ?? null;
}

export function getComposerDraftState(
  state: Pick<ComposerDraftStoreState, "draftsByThreadKey" | "draftThreadsByThreadKey">,
  target: ComposerThreadTarget,
): ComposerThreadDraftState | null {
  const threadKey = resolveComposerDraftKey(state, target);

  if (!threadKey) {
    return null;
  }

  return state.draftsByThreadKey[threadKey] ?? null;
}

export function isComposerThreadKeyInUse(
  mappings: Record<string, string>,
  threadKey: string,
): boolean {
  return Object.values(mappings).includes(threadKey);
}

export function toProjectDraftSession(
  draftId: DraftId,
  draftSession: DraftSessionState,
): ProjectDraftSession {
  return {
    draftId,
    ...draftSession,
  };
}

export function createDraftThreadState(
  projectRef: ScopedProjectRef,
  threadId: ThreadId,
  logicalProjectKey: string,
  existingThread: DraftThreadState | undefined,
  options?: {
    threadId?: ThreadId;
    branch?: string | null;
    worktreePath?: string | null;
    createdAt?: string;
    envMode?: DraftThreadEnvMode;
    startFromOrigin?: boolean;
    runtimeMode?: RuntimeMode;
    interactionMode?: ProviderInteractionMode;
  },
): DraftThreadState {
  // A project change (including switching environments within a logical
  // project) invalidates machine-specific context: the branch may not exist
  // there and the worktree path certainly doesn't. The user's *intent* —
  // env mode and start-from-origin — is machine-independent and carries.
  const projectChanged =
    existingThread !== undefined &&
    (existingThread.environmentId !== projectRef.environmentId ||
      existingThread.projectId !== projectRef.projectId);

  const nextWorktreePath =
    options?.worktreePath === undefined
      ? projectChanged
        ? null
        : (existingThread?.worktreePath ?? null)
      : (options.worktreePath ?? null);

  const nextBranch =
    options?.branch === undefined
      ? projectChanged
        ? null
        : (existingThread?.branch ?? null)
      : (options.branch ?? null);

  const nextStartFromOrigin =
    options?.startFromOrigin === undefined
      ? (existingThread?.startFromOrigin ?? false)
      : options.startFromOrigin;

  return {
    threadId,
    environmentId: projectRef.environmentId,
    projectId: projectRef.projectId,
    logicalProjectKey,
    createdAt: options?.createdAt ?? existingThread?.createdAt ?? new Date().toISOString(),
    runtimeMode:
      options?.runtimeMode ?? existingThread?.runtimeMode ?? DEFAULT_LOCAL_EXECUTION_MODE,
    interactionMode:
      options?.interactionMode ?? existingThread?.interactionMode ?? DEFAULT_INTERACTION_MODE,
    branch: nextBranch,
    worktreePath: nextWorktreePath,
    envMode:
      options?.envMode ?? (nextWorktreePath ? "worktree" : (existingThread?.envMode ?? "local")),
    startFromOrigin: nextStartFromOrigin,
    promotedTo: null,
  };
}

export function scopedThreadRefsEqual(
  left: ScopedThreadRef | null | undefined,
  right: ScopedThreadRef | null | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }

  return left.environmentId === right.environmentId && left.threadId === right.threadId;
}

export function isDraftThreadPromoting(draftThread: DraftThreadState | null | undefined): boolean {
  return draftThread?.promotedTo !== null && draftThread?.promotedTo !== undefined;
}

export function draftThreadsEqual(
  left: DraftThreadState | undefined,
  right: DraftThreadState,
): boolean {
  return (
    !!left &&
    left.threadId === right.threadId &&
    left.environmentId === right.environmentId &&
    left.projectId === right.projectId &&
    left.logicalProjectKey === right.logicalProjectKey &&
    left.createdAt === right.createdAt &&
    left.runtimeMode === right.runtimeMode &&
    left.interactionMode === right.interactionMode &&
    left.branch === right.branch &&
    left.worktreePath === right.worktreePath &&
    left.envMode === right.envMode &&
    left.startFromOrigin === right.startFromOrigin &&
    scopedThreadRefsEqual(left.promotedTo, right.promotedTo)
  );
}

export function removeDraftThreadReferences(
  state: Pick<
    ComposerDraftStoreState,
    | "draftThreadsByThreadKey"
    | "draftsByThreadKey"
    | "logicalProjectDraftThreadKeyByLogicalProjectKey"
  >,
  threadKey: string,
): Pick<
  ComposerDraftStoreState,
  | "draftThreadsByThreadKey"
  | "draftsByThreadKey"
  | "logicalProjectDraftThreadKeyByLogicalProjectKey"
> {
  const nextLogicalMappings = Object.fromEntries(
    Object.entries(state.logicalProjectDraftThreadKeyByLogicalProjectKey).filter(
      ([, draftThreadKey]) => draftThreadKey !== threadKey,
    ),
  ) as Record<string, string>;

  const { [threadKey]: _removedDraftThread, ...restDraftThreadsByThreadKey } =
    state.draftThreadsByThreadKey;

  const { [threadKey]: removedComposerDraft, ...restDraftsByThreadKey } = state.draftsByThreadKey;
  revokeDraftThreadPreviewUrls(removedComposerDraft);

  return {
    draftsByThreadKey: restDraftsByThreadKey,
    draftThreadsByThreadKey: restDraftThreadsByThreadKey,
    logicalProjectDraftThreadKeyByLogicalProjectKey: nextLogicalMappings,
  };
}
