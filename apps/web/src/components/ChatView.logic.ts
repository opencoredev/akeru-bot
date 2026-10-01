import {
  isProviderDriverKind,
  PLACEHOLDER_THREAD_TITLE,
  type EnvironmentId,
  type MessageId,
  type ModelSelection,
  type ProviderDriverKind,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ServerProvider,
  type ThreadId,
  type TurnId,
} from "@akeru/contracts";
import type { ComposerSubmissionIntent } from "../composer-logic";
import type { DraftThreadEnvMode } from "../composerDraftStore";
import { type ComposerImageAttachment, type DraftThreadState } from "../composerDraftStore";
import {
  filterTerminalContextsWithText,
  stripInlineTerminalContextPlaceholders,
  type TerminalContextDraft,
} from "../lib/terminalContext";
import { appAtomRegistry } from "../rpc/atomRegistry";
import type { TimelineEntry } from "../session-logic";
import { environmentThreadDetails } from "../state/threads";
import { type ChatMessage, type Thread, type ThreadShell } from "../types";

export const MAX_HIDDEN_MOUNTED_PREVIEW_THREADS = 3;

export const ENVIRONMENT_RECONNECT_WARNING_GRACE_MS = 2_000;

export function shouldDockDraftHeroForSubmission(input: {
  isDraftHeroState: boolean;
  activeThreadKey: string | null;
  submissionIntent: ComposerSubmissionIntent;
}): boolean {
  return (
    input.submissionIntent === "foreground" &&
    input.isDraftHeroState &&
    input.activeThreadKey !== null
  );
}

export function shouldReleaseTimelineAnchorForToolActivity(input: {
  anchorMessageId: MessageId | null;
  liveFollowEnabled: boolean;
  runningTurnId: TurnId | null;
  timelineEntries: ReadonlyArray<TimelineEntry>;
}): boolean {
  if (input.anchorMessageId === null || !input.liveFollowEnabled || input.runningTurnId === null) {
    return false;
  }

  return input.timelineEntries.some((timelineEntry) => {
    if (timelineEntry.kind !== "work" || timelineEntry.entry.turnId !== input.runningTurnId) {
      return false;
    }

    const entry = timelineEntry.entry;

    return (
      entry.tone === "tool" ||
      entry.itemType !== undefined ||
      entry.requestKind !== undefined ||
      (entry.command?.trim().length ?? 0) > 0
    );
  });
}

export function resolveDraftHeroState(input: {
  isLocalDraftThread: boolean;
  hasTimelineEntries: boolean;
  isWorking: boolean;
  draftHeroDockRequested: boolean;
  backgroundSubmissionPending: boolean;
}): boolean {
  if (input.backgroundSubmissionPending) {
    return true;
  }

  return (
    input.isLocalDraftThread &&
    !input.hasTimelineEntries &&
    !input.isWorking &&
    !input.draftHeroDockRequested
  );
}

export function resolveDraftPromotionNavigationTarget(input: {
  serverThreadRef: ScopedThreadRef | null;
  serverThreadStarted: boolean;
  backgroundSubmissionPending: boolean;
}): ScopedThreadRef | null {
  if (input.backgroundSubmissionPending) {
    return null;
  }

  return input.serverThreadStarted ? input.serverThreadRef : null;
}

export function scheduleEnvironmentReconnectWarning(showWarning: () => void): () => void {
  const timeoutId = globalThis.setTimeout(showWarning, ENVIRONMENT_RECONNECT_WARNING_GRACE_MS);

  return () => globalThis.clearTimeout(timeoutId);
}

export function hasEnvironmentReconnectWarningGraceElapsed(
  activeEnvironmentId: EnvironmentId | null,
  elapsedEnvironmentId: EnvironmentId | null,
): boolean {
  return activeEnvironmentId !== null && activeEnvironmentId === elapsedEnvironmentId;
}

export function startNewThreadForProject(
  projectRef: ScopedProjectRef | null,
  handleNewThread: (projectRef: ScopedProjectRef) => Promise<unknown>,
): boolean {
  if (projectRef === null) return false;
  void handleNewThread(projectRef);

  return true;
}

export function resolveThreadMetadataUpdateForNextTurn(input: {
  currentModelSelection: ModelSelection;
  nextModelSelection?: ModelSelection;
  currentBranch: string | null;
  nextBranch?: string;
}): {
  modelSelection?: ModelSelection;
  branch?: string;
  worktreePath?: null;
} | null {
  const nextModelSelection = input.nextModelSelection;

  const modelSelectionChanged =
    nextModelSelection !== undefined &&
    (nextModelSelection.model !== input.currentModelSelection.model ||
      nextModelSelection.instanceId !== input.currentModelSelection.instanceId ||
      JSON.stringify(nextModelSelection.options ?? null) !==
        JSON.stringify(input.currentModelSelection.options ?? null));

  const branchChanged = input.nextBranch !== undefined && input.nextBranch !== input.currentBranch;

  if (!modelSelectionChanged && !branchChanged) {
    return null;
  }

  return {
    ...(modelSelectionChanged ? { modelSelection: nextModelSelection } : {}),
    ...(branchChanged ? { branch: input.nextBranch, worktreePath: null } : {}),
  };
}

export function buildLocalDraftThread(
  threadId: ThreadId,
  draftThread: DraftThreadState,
  fallbackModelSelection: ModelSelection,
): Thread {
  return {
    id: threadId,
    environmentId: draftThread.environmentId,
    projectId: draftThread.projectId,
    title: PLACEHOLDER_THREAD_TITLE,
    modelSelection: fallbackModelSelection,
    runtimeMode: draftThread.runtimeMode,
    interactionMode: draftThread.interactionMode,
    session: null,
    messages: [],
    createdAt: draftThread.createdAt,
    updatedAt: draftThread.createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: draftThread.branch,
    worktreePath: draftThread.worktreePath,
    checkpoints: [],
    activities: [],
    proposedPlans: [],
  };
}

export function buildLoadingThreadFromShell(shell: ThreadShell): Thread {
  return {
    ...shell,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    deletedAt: null,
  };
}

export function shouldWriteThreadErrorToCurrentServerThread(input: {
  activeServerThread:
    | {
        environmentId: EnvironmentId;
        id: ThreadId;
      }
    | null
    | undefined;
  routeThreadRef: ScopedThreadRef;
  targetThreadId: ThreadId;
}): boolean {
  return Boolean(
    input.activeServerThread &&
    input.targetThreadId === input.routeThreadRef.threadId &&
    input.activeServerThread.environmentId === input.routeThreadRef.environmentId &&
    input.activeServerThread.id === input.targetThreadId,
  );
}

export function buildThreadTurnInterruptInput(thread: Pick<Thread, "id" | "session">): {
  threadId: ThreadId;
  turnId?: TurnId;
} {
  const runningTurnId = thread.session?.status === "running" ? thread.session.activeTurnId : null;

  return {
    threadId: thread.id,
    ...(runningTurnId !== null ? { turnId: runningTurnId } : {}),
  };
}

export function revokeBlobPreviewUrl(previewUrl: string | undefined): void {
  if (!previewUrl || typeof URL === "undefined" || !previewUrl.startsWith("blob:")) {
    return;
  }

  URL.revokeObjectURL(previewUrl);
}

export function revokeUserMessagePreviewUrls(message: ChatMessage): void {
  if (message.role !== "user" || !message.attachments) {
    return;
  }

  for (const attachment of message.attachments) {
    if (attachment.type !== "image") {
      continue;
    }

    revokeBlobPreviewUrl(attachment.previewUrl);
  }
}

export function collectUserMessageBlobPreviewUrls(message: ChatMessage): string[] {
  if (message.role !== "user" || !message.attachments) {
    return [];
  }

  const previewUrls: string[] = [];

  for (const attachment of message.attachments) {
    if (attachment.type !== "image") continue;

    if (!attachment.previewUrl || !attachment.previewUrl.startsWith("blob:")) continue;
    previewUrls.push(attachment.previewUrl);
  }

  return previewUrls;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);

        return;
      }

      reject(new Error("Could not read image data."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read image."));
    });
    reader.readAsDataURL(file);
  });
}

export function resolveSendEnvMode(input: {
  requestedEnvMode: DraftThreadEnvMode;
  isGitRepo: boolean;
}): DraftThreadEnvMode {
  return input.isGitRepo ? input.requestedEnvMode : "local";
}

export const WORKTREE_BRANCHES_LOADING_REASON = "Loading repository branches";

export const WORKTREE_BASE_BRANCH_MISSING_ERROR =
  "No base branch found. Create or check out a Git branch, or choose Current checkout in Project settings.";

export type WorktreeSendGate =
  | { state: "ready" }
  | { state: "loading"; sendDisabledReason: string }
  | { state: "missing-base-branch"; errorMessage: string };

/**
 * Gates a first send that must create a worktree. While refs load, the send
 * button is disabled with a loading reason. Once refs settle without any
 * resolvable base branch, send stays enabled so submitting surfaces an
 * actionable error instead of a dead button.
 */
export function resolveWorktreeSendGate(input: {
  needsWorktreeBaseBranch: boolean;
  refsLoadPending: boolean;
  resolvedBranch: string | null;
}): WorktreeSendGate {
  if (!input.needsWorktreeBaseBranch || input.resolvedBranch !== null) {
    return { state: "ready" };
  }

  if (input.refsLoadPending) {
    return { state: "loading", sendDisabledReason: WORKTREE_BRANCHES_LOADING_REASON };
  }

  return { state: "missing-base-branch", errorMessage: WORKTREE_BASE_BRANCH_MISSING_ERROR };
}

/**
 * Runs the supplied send continuation only when worktree branch resolution
 * permits it. Loading blocks silently. A missing base branch writes the
 * actionable thread error and blocks.
 */
export async function crossWorktreeSendBoundary<Result>(input: {
  gate: WorktreeSendGate;
  requiresWorktreeCreation: boolean;
  threadId: ThreadId;
  setThreadError: (threadId: ThreadId, error: string | null) => void;
  send: () => Result | Promise<Result>;
}): Promise<
  | { outcome: "sent"; result: Result }
  | { outcome: "blocked-loading" }
  | { outcome: "blocked-missing-base-branch" }
> {
  if (input.requiresWorktreeCreation && input.gate.state === "loading") {
    return { outcome: "blocked-loading" };
  }

  if (input.requiresWorktreeCreation && input.gate.state === "missing-base-branch") {
    input.setThreadError(input.threadId, input.gate.errorMessage);

    return { outcome: "blocked-missing-base-branch" };
  }

  return { outcome: "sent", result: await input.send() };
}

export function cloneComposerImageForRetry(
  image: ComposerImageAttachment,
): ComposerImageAttachment {
  if (typeof URL === "undefined" || !image.previewUrl.startsWith("blob:")) {
    return image;
  }

  try {
    return {
      ...image,
      previewUrl: URL.createObjectURL(image.file),
    };
  } catch {
    return image;
  }
}

export function deriveComposerSendState(options: {
  prompt: string;
  imageCount: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  /**
   * Optional element-pick attachment count. Element contexts contribute to
   * "sendable content" exactly like images and (text-bearing) terminal
   * contexts do: a prompt of just element chips is still a valid send.
   */
  elementContextCount?: number;
}): {
  trimmedPrompt: string;
  sendableTerminalContexts: TerminalContextDraft[];
  expiredTerminalContextCount: number;
  hasSendableContent: boolean;
} {
  const trimmedPrompt = stripInlineTerminalContextPlaceholders(options.prompt).trim();
  const sendableTerminalContexts = filterTerminalContextsWithText(options.terminalContexts);

  const expiredTerminalContextCount =
    options.terminalContexts.length - sendableTerminalContexts.length;

  const elementContextCount = options.elementContextCount ?? 0;

  return {
    trimmedPrompt,
    sendableTerminalContexts,
    expiredTerminalContextCount,
    hasSendableContent:
      trimmedPrompt.length > 0 ||
      options.imageCount > 0 ||
      sendableTerminalContexts.length > 0 ||
      elementContextCount > 0,
  };
}

export function threadHasStarted(thread: Thread | null | undefined): boolean {
  return Boolean(
    thread && (thread.latestTurn !== null || thread.messages.length > 0 || thread.session !== null),
  );
}

// `threadProvider` is the open branded driver kind carried by the session.
// Unknown driver kinds degrade to `null` (i.e. "unlocked"), which is the safe
// rollback / fork behavior — the routing layer is the right place to surface
// "driver not installed" errors, not the lock state.
//
// `selectedProvider` takes the same open-string shape because the composer
// now tracks the picker selection as a `ProviderInstanceId` (e.g.
// `codex_personal`). Custom instance ids that don't directly match a
// registered driver resolve to `null` here, which matches the existing
// "unknown driver -> unlocked" semantics. Callers that want the lock to track
// a custom instance's underlying driver kind should resolve the instance id
// upstream and pass the correlated kind.
export function deriveLockedProvider(input: {
  thread: Thread | null | undefined;
  selectedProvider: string | null;
  threadProvider: string | null;
}): ProviderDriverKind | null {
  if (!threadHasStarted(input.thread)) {
    return null;
  }

  const sessionProvider = input.thread?.session?.providerName ?? null;

  if (sessionProvider && isProviderDriverKind(sessionProvider)) {
    return sessionProvider;
  }

  const narrowedThreadProvider =
    input.threadProvider && isProviderDriverKind(input.threadProvider)
      ? input.threadProvider
      : null;

  const narrowedSelectedProvider =
    input.selectedProvider && isProviderDriverKind(input.selectedProvider)
      ? input.selectedProvider
      : null;

  return narrowedThreadProvider ?? narrowedSelectedProvider ?? null;
}

export function getStartedThreadModelChangeBlockReason(input: {
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "requiresNewThreadForModelChange">>;
  hasStartedSession: boolean;
  currentModelSelection: ModelSelection;
  currentProviderInstanceId?: ModelSelection["instanceId"] | null | undefined;
  nextModelSelection: ModelSelection;
}): { title: string; description: string } | null {
  if (!input.hasStartedSession) {
    return null;
  }

  const currentModelSelection = {
    ...input.currentModelSelection,
    instanceId: input.currentProviderInstanceId ?? input.currentModelSelection.instanceId,
  };

  if (
    currentModelSelection.instanceId === input.nextModelSelection.instanceId &&
    currentModelSelection.model === input.nextModelSelection.model
  ) {
    return null;
  }

  const currentProvider = input.providers.find(
    (snapshot) => snapshot.instanceId === currentModelSelection.instanceId,
  );

  const nextProvider = input.providers.find(
    (snapshot) => snapshot.instanceId === input.nextModelSelection.instanceId,
  );

  if (
    currentProvider?.requiresNewThreadForModelChange !== true &&
    nextProvider?.requiresNewThreadForModelChange !== true
  ) {
    return null;
  }

  return {
    title: "Start a new chat to change models",
    description: "This provider does not allow switching models after a conversation has started.",
  };
}

export async function waitForStartedServerThread(
  threadRef: ScopedThreadRef,
  timeoutMs = 1_000,
): Promise<boolean> {
  const threadAtom = environmentThreadDetails.detailAtom(threadRef);
  const getThread = () => appAtomRegistry.get(threadAtom);
  const thread = getThread();

  if (threadHasStarted(thread)) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;

    const finish = (result: boolean) => {
      if (settled) {
        return;
      }

      settled = true;

      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }

      unsubscribe();
      resolve(result);
    };

    const unsubscribe = appAtomRegistry.subscribe(threadAtom, (thread) => {
      if (!threadHasStarted(thread)) {
        return;
      }

      finish(true);
    });

    if (threadHasStarted(getThread())) {
      finish(true);

      return;
    }

    timeoutId = globalThis.setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}

export {
  buildFirstSendBootstrap,
  buildFirstSendTurnInput,
  resolveBackgroundDraftWorkspaceOptions,
  resolveComposerBranchForSend,
} from "./chat/firstSend.logic";

export {
  createLocalDispatchSnapshot,
  hasServerAcknowledgedLocalDispatch,
  type LocalDispatchSnapshot,
} from "./chat/localDispatch.logic";

export {
  branchMismatchKey,
  dismissBranchMismatchForSession,
  isBranchMismatchDismissedForSession,
  reconcileRetainedMountedThreadIds,
  shouldShowBranchMismatchBanner,
} from "./chat/threadLifecycle.logic";
