import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";
import * as Cause from "effect/Cause";

import {
  CommandId,
  MessageId,
  type EnvironmentId,
  type ModelSelection,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  codexFeedbackMessage,
  parseCodexFeedbackCommand,
  submitCodexFeedback,
  type CodexFeedbackSubmission,
} from "@t3tools/client-runtime/state/threads";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { deriveActiveWorkStartedAt } from "@t3tools/shared/orchestrationTiming";

import { makeQueuedMessageMetadata } from "../lib/commandMetadata";
import {
  convertPastedImagesToAttachments,
  pasteComposerClipboard,
  pickComposerImages,
} from "../lib/composerImages";
import { scopedThreadKey } from "../lib/scopedEntities";
import { copyTextWithHaptic } from "../lib/copyTextWithHaptic";
import { useMobileI18n } from "../lib/i18n";
import {
  buildThreadFeed,
  deriveThreadFeedDelegations,
  unchangedPrefixLength,
  type ThreadFeedDelegations,
} from "../lib/threadActivity";
import { tryOpenExternalUrl } from "../lib/openExternalUrl";
import {
  appendComposerDraftAttachments,
  appendComposerDraftText,
  clearComposerDraftContent,
  composerDraftsAtom,
  ensureComposerDraftsLoaded,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  removeComposerDraftAttachment,
  setComposerDraftText,
  updateComposerDraftSettings,
  useComposerDraft,
  useComposerDraftSettings,
} from "./use-composer-drafts";
import { setPendingConnectionError } from "../state/use-remote-environment-registry";
import { useSelectedThreadDetail } from "../state/use-thread-detail";
import { useThreadSelection } from "../state/use-thread-selection";
import { environmentSnapshotAtom } from "../state/shell";
import { enqueueThreadOutboxMessage } from "./thread-outbox";
import { useThreadOutboxMessages } from "./use-thread-outbox";
import { threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";

export function useThreadDraftForThread(input: {
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
}) {
  const threadKey =
    input.environmentId && input.threadId
      ? scopedThreadKey(input.environmentId, input.threadId)
      : null;
  const draft = useComposerDraft(threadKey);

  return {
    draftMessage: draft.text,
    draftAttachments: draft.attachments,
  };
}

const feedDelegationsAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = key.split("\n") as [
    EnvironmentId | undefined,
    ThreadId | undefined,
  ];
  return Atom.make((get) =>
    deriveThreadFeedDelegations(
      threadId,
      environmentId === undefined
        ? undefined
        : (get(environmentSnapshotAtom(environmentId))?.delegations ?? []),
    ),
  ).pipe(Atom.withLabel(`mobile-feed-delegations:${key}`));
});

export function useThreadComposerState() {
  const { t } = useMobileI18n();
  const { selectedThread: selectedThreadShell, selectedEnvironmentRuntime } = useThreadSelection();
  const selectedThreadDetail = useSelectedThreadDetail();
  const openedAuthorizationActivitiesRef = useRef(new Set<string>());
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const [feedbackSubmissionsByThreadKey, setFeedbackSubmissionsByThreadKey] = useState<
    Record<string, ReadonlyArray<CodexFeedbackSubmission>>
  >({});
  const uploadThreadFeedback = useAtomCommand(threadEnvironment.uploadFeedback, {
    reportFailure: false,
  });

  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);

  const scannedAuthorizationActivitiesRef = useRef<ReadonlyArray<unknown>>([]);
  useEffect(() => {
    const activities = selectedThreadDetail?.activities ?? [];
    // Activity updates usually append, so only the unseen tail is scanned.
    const start = unchangedPrefixLength(scannedAuthorizationActivitiesRef.current, activities);
    scannedAuthorizationActivitiesRef.current = activities;
    for (let index = start; index < activities.length; index += 1) {
      const activity = activities[index];
      if (activity?.kind !== "mcp.oauth.authorization-required") continue;
      if (openedAuthorizationActivitiesRef.current.has(activity.id)) continue;
      if (!activity.payload || typeof activity.payload !== "object") continue;
      const authorizationUrl = (activity.payload as Record<string, unknown>).authorizationUrl;
      if (typeof authorizationUrl !== "string") continue;
      try {
        if (new URL(authorizationUrl).protocol !== "https:") continue;
      } catch {
        continue;
      }
      openedAuthorizationActivitiesRef.current.add(activity.id);
      void tryOpenExternalUrl(authorizationUrl, "mcp-oauth");
      // Leave later rows unscanned so the next update can open them.
      scannedAuthorizationActivitiesRef.current = activities.slice(0, index + 1);
      break;
    }
  }, [selectedThreadDetail?.activities]);

  const selectedThreadKey = selectedThreadShell
    ? scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id)
    : null;
  const selectedThreadQueuedMessages = useMemo(
    () => (selectedThreadKey ? (queuedMessagesByThreadKey[selectedThreadKey] ?? []) : []),
    [queuedMessagesByThreadKey, selectedThreadKey],
  );
  // Delegations live on the environment snapshot, not the thread detail.
  const selectedThreadDelegations = useAtomValue(
    feedDelegationsAtom(
      selectedThreadShell
        ? `${selectedThreadShell.environmentId}\n${selectedThreadShell.id}`
        : "\n",
    ),
  );
  const selectedThreadFeedDelegations = useMemo(
    () => JSON.parse(selectedThreadDelegations) as ThreadFeedDelegations,
    [selectedThreadDelegations],
  );
  const selectedThreadFeed = useMemo(() => {
    if (!selectedThreadDetail) {
      return [];
    }
    const submissions = selectedThreadKey
      ? (feedbackSubmissionsByThreadKey[selectedThreadKey] ?? [])
      : [];
    const { delegations } = selectedThreadFeedDelegations;
    return buildThreadFeed(selectedThreadDetail, {
      localMessages: submissions.flatMap((submission) =>
        submission.status === "interrupted"
          ? []
          : [codexFeedbackMessage(submission), codexFeedbackMessage(submission, "assistant")],
      ),
      delegations,
    });
  }, [
    feedbackSubmissionsByThreadKey,
    selectedThreadFeedDelegations,
    selectedThreadDetail,
    selectedThreadKey,
  ]);

  // Draft text and attachments are read by the composer itself, so typing
  // re-renders the composer rather than the whole thread route.
  const selectedDraft = useComposerDraftSettings(selectedThreadKey);
  const selectedThreadQueueCount = selectedThreadQueuedMessages.length;
  const selectedThread = selectedThreadDetail ?? selectedThreadShell;
<<<<<<< HEAD
  const modelSelection = selectedDraft.modelSelection ?? selectedThread?.modelSelection ?? null;
  const runtimeMode = selectedDraft.runtimeMode ?? selectedThread?.runtimeMode ?? null;
  const interactionMode = selectedDraft.interactionMode ?? selectedThread?.interactionMode ?? null;
||||||| parent of 21db1a319 (feat: retire review, terminal, source control, plan mode and project UI)
  const modelSelection = selectedDraft?.modelSelection ?? selectedThread?.modelSelection ?? null;
  const runtimeMode = selectedDraft?.runtimeMode ?? selectedThread?.runtimeMode ?? null;
  const interactionMode = selectedDraft?.interactionMode ?? selectedThread?.interactionMode ?? null;
=======
  const modelSelection = selectedDraft?.modelSelection ?? selectedThread?.modelSelection ?? null;
  const runtimeMode = selectedDraft?.runtimeMode ?? selectedThread?.runtimeMode ?? null;
>>>>>>> 21db1a319 (feat: retire review, terminal, source control, plan mode and project UI)

  const selectedThreadSessionActivity = useMemo(() => {
    const selectedThread = selectedThreadDetail ?? selectedThreadShell;
    if (!selectedThread?.session) {
      return null;
    }

    return {
      orchestrationStatus: selectedThread.session.status,
      activeTurnId: selectedThread.session.activeTurnId ?? undefined,
    };
  }, [selectedThreadDetail, selectedThreadShell]);

  const activeWorkStartedAt = useMemo(() => {
    const selectedThread = selectedThreadDetail ?? selectedThreadShell;
    if (!selectedThread) {
      return null;
    }

    return deriveActiveWorkStartedAt(
      selectedThread.latestTurn,
      selectedThreadSessionActivity,
      null,
    );
  }, [selectedThreadDetail, selectedThreadSessionActivity, selectedThreadShell]);

  const onSendMessage = useCallback(async () => {
    if (!selectedThreadShell) {
      return null;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const draft = getComposerDraftSnapshot(threadKey);
    const thread = selectedThreadDetail ?? selectedThreadShell;
    const text = draft.text.trim();
    const attachments = draft.attachments;
    if (text.length === 0 && attachments.length === 0) {
      return null;
    }

    const provider = selectedEnvironmentRuntime?.serverConfig?.providers.find(
      (entry) => entry.instanceId === thread.modelSelection.instanceId,
    );
    const feedbackCommand =
      attachments.length === 0 &&
      (provider?.driver === "codex" || thread.session?.providerName === "codex")
        ? parseCodexFeedbackCommand(text)
        : null;
    if (feedbackCommand) {
      if (thread.session === null) {
        Alert.alert(t("Start a Codex chat first"), t("Send a message before you submit feedback."));
        return null;
      }
      const metadata = makeQueuedMessageMetadata();
      const result = await submitCodexFeedback({
        submission: {
          id: MessageId.make(metadata.messageId),
          command: text,
          createdAt: metadata.createdAt,
        },
        clearDraft: () => clearComposerDraftContent(threadKey),
        onUpdate: (submission) => {
          setFeedbackSubmissionsByThreadKey((current) => {
            const existing = current[threadKey] ?? [];
            const found = existing.some((entry) => entry.id === submission.id);
            return {
              ...current,
              [threadKey]: found
                ? existing.map((entry) => (entry.id === submission.id ? submission : entry))
                : [...existing, submission],
            };
          });
        },
        upload: () =>
          uploadThreadFeedback({
            environmentId: selectedThreadShell.environmentId,
            input: {
              threadId: selectedThreadShell.id,
              ...feedbackCommand,
            },
          }),
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          return null;
        }
        const error = Cause.squash(result.cause);
        Alert.alert(
          t("Could not send feedback to OpenAI"),
          error instanceof Error ? error.message : t("An error occurred."),
        );
        return null;
      }
      const feedbackId = result.value.feedbackId;
      Alert.alert(t("Feedback sent to OpenAI"), t("Thread ID: {id}", { id: feedbackId }), [
        { text: t("OK"), style: "cancel" },
        {
          text: t("Copy ID"),
          onPress: () => copyTextWithHaptic(feedbackId, { target: "Codex feedback thread ID" }),
        },
      ]);
      return null;
    }

    const metadata = makeQueuedMessageMetadata();
    const messageId = MessageId.make(metadata.messageId);
    // Enqueue publishes the queued atom synchronously (the durable write
    // happens behind it), so clearing the draft here gives send feedback on
    // the tap frame instead of after file I/O. If the write fails the message
    // is rolled out of the queue and the content is merged back into the
    // draft, preserving anything typed since.
    const enqueuePromise = enqueueThreadOutboxMessage({
      environmentId: selectedThreadShell.environmentId,
      threadId: selectedThreadShell.id,
      messageId,
      commandId: CommandId.make(metadata.commandId),
      text,
      attachments,
      modelSelection: draft.modelSelection ?? thread.modelSelection,
      runtimeMode: draft.runtimeMode ?? thread.runtimeMode,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: metadata.createdAt,
    });
    clearComposerDraftContent(threadKey);
    enqueuePromise.catch((error: unknown) => {
      // Restore text via merge (idempotent) but attachments via the uncapped
      // append: the merge path slots existing attachments first and truncates
      // at the send limit, which would silently drop this message's images if
      // the user attached new ones while the write was in flight.
      void mergeComposerDraftContent(threadKey, { text, attachments: [] });
      appendComposerDraftAttachments(threadKey, attachments);
      setPendingConnectionError(
        error instanceof Error ? error.message : "Failed to save the queued message.",
      );
    });
    return messageId;
  }, [
    selectedEnvironmentRuntime?.serverConfig?.providers,
    selectedThreadDetail,
    selectedThreadShell,
    t,
    uploadThreadFeedback,
  ]);

  const onChangeDraftMessage = useCallback(
    (value: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      setComposerDraftText(threadKey, value);
    },
    [selectedThreadShell],
  );

  const onPickDraftImages = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const result = await pickComposerImages({
      existingCount: getComposerDraftSnapshot(threadKey).attachments.length,
    });
    if (result.images.length > 0) {
      appendComposerDraftAttachments(threadKey, result.images);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    }
  }, [selectedThreadShell]);

  const onPasteIntoDraft = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const result = await pasteComposerClipboard({
      existingCount: getComposerDraftSnapshot(threadKey).attachments.length,
    });
    if (result.images.length > 0) {
      appendComposerDraftAttachments(threadKey, result.images);
    }
    if (result.text) {
      appendComposerDraftText(threadKey, result.text);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    }
  }, [selectedThreadShell]);

  const onNativePasteImages = useCallback(
    async (uris: ReadonlyArray<string>) => {
      if (!selectedThreadShell || uris.length === 0) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      try {
        const images = await convertPastedImagesToAttachments({
          uris,
          existingCount: getComposerDraftSnapshot(threadKey).attachments.length,
        });
        if (images.length > 0) {
          appendComposerDraftAttachments(threadKey, images);
        }
      } catch (error) {
        console.error("[native paste] error converting images", {
          environmentId: selectedThreadShell.environmentId,
          threadId: selectedThreadShell.id,
          uriCount: uris.length,
          ...safeErrorLogAttributes(error),
        });
      }
    },
    [selectedThreadShell],
  );

  const onRemoveDraftImage = useCallback(
    (imageId: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      removeComposerDraftAttachment(threadKey, imageId);
    },
    [selectedThreadShell],
  );

  const onUpdateModelSelection = useCallback(
    (value: ModelSelection) => {
      if (!selectedThreadKey) {
        return;
      }
      updateComposerDraftSettings(selectedThreadKey, { modelSelection: value });
    },
    [selectedThreadKey],
  );

  const onUpdateRuntimeMode = useCallback(
    (value: RuntimeMode) => {
      if (!selectedThreadKey) {
        return;
      }
      updateComposerDraftSettings(selectedThreadKey, { runtimeMode: value });
    },
    [selectedThreadKey],
  );

  const selectedThreadWaitingOnChildren = selectedThreadFeedDelegations.waitingOnChildren;

  return {
    selectedThreadFeed,
    selectedThreadWaitingOnChildren,
    selectedThreadQueueCount,
    activeWorkStartedAt,
    modelSelection,
    runtimeMode,
    onChangeDraftMessage,
    onPickDraftImages,
    onPasteIntoDraft,
    onNativePasteImages,
    onRemoveDraftImage,
    onSendMessage,
    onUpdateModelSelection,
    onUpdateRuntimeMode,
  };
}
