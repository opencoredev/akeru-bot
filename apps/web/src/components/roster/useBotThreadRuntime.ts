import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  BotId,
  PLACEHOLDER_THREAD_TITLE,
  type ApprovalRequestId,
  EnvironmentId,
  type MessageId,
  type ModelSelection,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { DEFAULT_INTERACTION_MODE } from "../../types";
import { newMessageId, newThreadId } from "../../lib/utils";
import { resolveAppModelSelectionState } from "../../modelSelection";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  readEnvironmentSupportsFileAttachments,
  useThreadActivities,
  useThreadMessages,
  useThreadShells,
} from "../../state/entities";
import { environmentBotsAtom } from "../../state/bots";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerProvidersAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { derivePendingUserInputs } from "../../session-logic";
import {
  applyPendingUserInputSingleSelect,
  buildPendingUserInputAnswers,
  type PendingUserInputDraftAnswer,
  togglePendingUserInputOptionSelection,
} from "../../pendingUserInput";
import { sortScopedProjectsForSidebar } from "../Sidebar.logic";
import {
  buildBotTurnStartInput,
  createBotTurnSubmissionQueue,
  findLatestBotThreadTarget,
  findUnhandledMcpAuthorization,
  joinOrStartThreadCreate,
  nextRetainedChat,
  preferRetainedChatTarget,
  resolveBotThreadTarget,
  shouldTitlePlaceholderChat,
  type RetainedChat,
} from "./botThreadRuntime.logic";
import { useRosterStore } from "./rosterStore";
import { useBotChatTarget } from "./useBotThreadRef";
import { ensureLocalApi } from "../../localApi";
import { resolveBotFileAttachment } from "./botFileAttachment";
import {
  type BotThreadFailure,
  commandFailure,
  latestBotThreadFailure,
  localFailure,
} from "./threadRuntimeWarning.logic";

const NO_ENVIRONMENT = "" as EnvironmentId;

function threadTitle(prompt: string, files: readonly File[]): string {
  const seed = prompt || (files[0] ? `File: ${files[0].name}` : "New chat");
  return seed.length > 80 ? `${seed.slice(0, 79)}…` : seed;
}

function readFileAsDataUrl(file: File, mimeType: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener(
      "error",
      () => reject(reader.error ?? new Error(`Could not read ${file.name}.`)),
      { once: true },
    );
    reader.addEventListener(
      "load",
      () =>
        typeof reader.result === "string"
          ? resolve(`data:${mimeType};base64,${reader.result.split(",", 2)[1] ?? ""}`)
          : reject(new Error(`Could not read ${file.name}.`)),
      { once: true },
    );
    reader.readAsDataURL(file);
  });
}

export function useBotThreadRuntime(botId: string, effectiveModelSelection: ModelSelection | null) {
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const serverBots = useAtomValue(environmentBotsAtom(primaryEnvironmentId ?? NO_ENVIRONMENT));
  const threadShells = useThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const settings = usePrimarySettings();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const rememberedPath = useRosterStore((state) => state.chatPathByBotId[botId]);
  const openThreadId = useRosterStore((state) => state.openChatByBotId[botId] ?? null);
  const bot = useRosterStore((state) => state.bots.find((candidate) => candidate.id === botId));
  const primaryThreadShells = useMemo(
    () =>
      primaryEnvironmentId
        ? threadShells.filter((thread) => thread.environmentId === primaryEnvironmentId)
        : [],
    [primaryEnvironmentId, threadShells],
  );
  // An opened chat that has become the newest, after a send say, no longer
  // needs pinning; keeping the pin would hide a later chat from the default view.
  const latestThreadId = primaryEnvironmentId
    ? (findLatestBotThreadTarget(botId, primaryEnvironmentId, primaryThreadShells)?.threadId ??
      null)
    : null;
  useEffect(() => {
    if (openThreadId !== null && openThreadId === latestThreadId) {
      useRosterStore.getState().openBotChat(botId, null);
    }
  }, [botId, latestThreadId, openThreadId]);
  // Holds a just-created chat until its shell arrives. A chat that was linked
  // and then left the shell list was archived or deleted, so it is dropped
  // rather than sent into.
  const retainedThreadRef = useRef<RetainedChat>({
    ownerId: botId,
    threadRef: null,
    linked: false,
  });
  if (retainedThreadRef.current.ownerId !== botId) {
    retainedThreadRef.current = { ownerId: botId, threadRef: null, linked: false };
  }
  const target = preferRetainedChatTarget(
    retainedThreadRef.current,
    primaryEnvironmentId
      ? resolveBotThreadTarget(
          botId,
          primaryEnvironmentId,
          primaryThreadShells,
          rememberedPath,
          openThreadId,
        )
      : null,
    primaryThreadShells,
  );
  const { ref: rememberedThreadRef, shell: rememberedThread } = useBotChatTarget(botId, target);
  const linkedThreadRef = rememberedThread ? rememberedThreadRef : null;
  const threadShellsRef = useRef(primaryThreadShells);
  threadShellsRef.current = primaryThreadShells;
  retainedThreadRef.current = nextRetainedChat(
    retainedThreadRef.current,
    linkedThreadRef,
    bootstrapped,
    openThreadId,
  );
  const messages = useThreadMessages(linkedThreadRef);
  const activities = useThreadActivities(linkedThreadRef);
  const openedAuthorizationActivitiesRef = useRef(new Set<string>());
  useEffect(() => {
    const authorization = findUnhandledMcpAuthorization(
      activities,
      openedAuthorizationActivitiesRef.current,
    );
    if (!authorization) return;
    openedAuthorizationActivitiesRef.current.add(authorization.activityId);
    void ensureLocalApi().shell.openExternal(authorization.url);
  }, [activities]);
  const pendingUserInputs = useMemo(() => derivePendingUserInputs(activities), [activities]);
  const defaultProject = useMemo(
    () =>
      bootstrapped && primaryEnvironmentId
        ? (sortScopedProjectsForSidebar(
            projects.filter((project) => project.environmentId === primaryEnvironmentId),
            primaryThreadShells,
            "updated_at",
          )[0] ?? null)
        : null,
    [bootstrapped, primaryEnvironmentId, primaryThreadShells, projects],
  );
  const activeProject =
    projects.find(
      (project) =>
        project.environmentId === rememberedThread?.environmentId &&
        project.id === rememberedThread.projectId,
    ) ?? defaultProject;
  const appDefaultModelSelection = useMemo(
    () => resolveAppModelSelectionState(settings, providers),
    [providers, settings],
  );
  const setRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const resumeTurnCommand = useAtomCommand(threadEnvironment.resumeTurn, { reportFailure: false });
  const respondToUserInputCommand = useAtomCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const appendVoiceTranscript = useAtomCommand(threadEnvironment.appendVoiceTranscript, {
    reportFailure: false,
  });
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const ensureThreadRef = useRef<Promise<ScopedThreadRef | null> | null>(null);
  const startingNewChatRef = useRef(false);
  // Sends made while New chat is still creating wait for it instead of reaching the old chat.
  const pendingNewChatRef = useRef<Promise<ScopedThreadRef | null> | null>(null);
  // The chat New chat created with a placeholder title, until a send titles it.
  const placeholderChatIdRef = useRef<string | null>(null);
  // The chat whose first send already requested its title, so a quick second send keeps it.
  const titledChatIdRef = useRef<string | null>(null);
  const botReady = serverBots.some((candidate) => candidate.id === botId);
  const sendQueueRef = useRef(createBotTurnSubmissionQueue());
  const queuedSendCountRef = useRef(0);
  const [sending, setSending] = useState(false);
  const [respondingRequestIds, setRespondingRequestIds] = useState<ApprovalRequestId[]>([]);
  const respondingRequestIdsRef = useRef(new Set<ApprovalRequestId>());
  const singleSelectInFlightRef = useRef<string | null>(null);
  const [pendingUserInputAnswers, setPendingUserInputAnswers] = useState<
    Record<string, PendingUserInputDraftAnswer>
  >({});
  const [pendingUserInputQuestionIndex, setPendingUserInputQuestionIndex] = useState(0);
  const [error, setError] = useState<BotThreadFailure | null>(null);
  const [resuming, setResuming] = useState(false);
  const canResume =
    linkedThreadRef !== null &&
    (rememberedThread?.session?.status === "error" ||
      rememberedThread?.session?.status === "interrupted" ||
      rememberedThread?.session?.status === "stopped") &&
    (rememberedThread?.latestTurn?.state === "error" ||
      rememberedThread?.latestTurn?.state === "interrupted" ||
      (rememberedThread?.latestTurn === null && messages?.at(-1)?.role === "user"));
  const resume = useCallback(async (): Promise<boolean> => {
    if (!linkedThreadRef || !canResume || resuming) return false;
    setResuming(true);
    setError(null);
    const result = await resumeTurnCommand({
      environmentId: linkedThreadRef.environmentId,
      input: { threadId: linkedThreadRef.threadId },
    });
    setResuming(false);
    if (result._tag === "Failure") {
      setError(commandFailure(result));
      return false;
    }
    return true;
  }, [canResume, linkedThreadRef, resumeTurnCommand, resuming]);
  const submitPendingUserInput = useCallback(
    async (
      requestId: ApprovalRequestId,
      answers: Record<string, string | string[]>,
    ): Promise<boolean> => {
      if (!linkedThreadRef || respondingRequestIdsRef.current.has(requestId)) return false;
      respondingRequestIdsRef.current.add(requestId);
      setRespondingRequestIds((current) =>
        current.includes(requestId) ? current : [...current, requestId],
      );
      const result = await respondToUserInputCommand({
        environmentId: linkedThreadRef.environmentId,
        input: {
          threadId: linkedThreadRef.threadId,
          requestId,
          answers,
        },
      });
      if (result._tag === "Failure") {
        respondingRequestIdsRef.current.delete(requestId);
        setRespondingRequestIds((current) => current.filter((id) => id !== requestId));
        setError(commandFailure(result));
        return false;
      }
      return true;
    },
    [linkedThreadRef, respondToUserInputCommand],
  );

  const createBotChat = useCallback(
    async (title: string): Promise<ScopedThreadRef | null> => {
      if (!activeProject) return null;
      const threadId = newThreadId();
      const result = await createThread({
        environmentId: activeProject.environmentId,
        input: {
          threadId,
          projectId: activeProject.id,
          botId: BotId.make(botId),
          title,
          modelSelection:
            effectiveModelSelection ??
            activeProject.defaultModelSelection ??
            appDefaultModelSelection,
          runtimeMode: bot?.runtimeMode ?? settings.localExecutionMode,
          interactionMode: DEFAULT_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt: new Date().toISOString(),
        },
      });
      if (result._tag === "Failure") return null;
      const threadRef = scopeThreadRef(activeProject.environmentId, threadId);
      retainedThreadRef.current = { ownerId: botId, threadRef, linked: false };
      const roster = useRosterStore.getState();
      roster.recordChatPath(botId, `/${threadRef.environmentId}/${threadRef.threadId}`);
      // A new chat is the newest one, so the bot stops showing an older chat.
      roster.openBotChat(botId, null);
      return threadRef;
    },
    [
      activeProject,
      appDefaultModelSelection,
      bot,
      botId,
      createThread,
      effectiveModelSelection,
      settings.localExecutionMode,
    ],
  );

  const ensureTranscriptThread = useCallback(
    async (title = `Call with ${bot?.name ?? "bot"}`): Promise<ScopedThreadRef | null> => {
      if (!activeProject || !botReady) return null;
      return joinOrStartThreadCreate({
        getRetained: () => retainedThreadRef.current.threadRef,
        inFlight: ensureThreadRef,
        start: () => createBotChat(title),
      });
    },
    [activeProject, bot?.name, botReady, createBotChat],
  );

  // A fresh chat only makes sense once the current one has a message; an empty
  // chat is already fresh, and creating another would leave it behind.
  const canStartNewChat =
    botReady &&
    activeProject !== null &&
    !sending &&
    linkedThreadRef !== null &&
    (messages?.length ?? 0) > 0;
  const startNewChat = useCallback(async (): Promise<boolean> => {
    if (!canStartNewChat || startingNewChatRef.current) return false;
    // A created chat waits here until its shell arrives; another click would leave it empty.
    const retained = retainedThreadRef.current;
    if (retained.threadRef !== null && !retained.linked) return false;
    startingNewChatRef.current = true;
    setError(null);
    const pending = createBotChat(PLACEHOLDER_THREAD_TITLE);
    pendingNewChatRef.current = pending;
    try {
      const threadRef = await pending;
      if (!threadRef) {
        setError(localFailure("Could not start a new chat."));
        return false;
      }
      placeholderChatIdRef.current = threadRef.threadId;
      return true;
    } finally {
      startingNewChatRef.current = false;
      if (pendingNewChatRef.current === pending) pendingNewChatRef.current = null;
    }
  }, [canStartNewChat, createBotChat]);

  const send = useCallback(
    async (
      prompt: string,
      files: readonly File[],
      voiceMessageId?: MessageId,
    ): Promise<boolean> => {
      const pendingUserInput = pendingUserInputs[0];
      if (pendingUserInput && linkedThreadRef && voiceMessageId !== undefined) {
        setError(localFailure("Answer the bot's question in chat, then keep talking."));
        return false;
      }
      if (pendingUserInput && linkedThreadRef && files.length === 0) {
        if (respondingRequestIds.includes(pendingUserInput.requestId)) return false;
        const question = pendingUserInput.questions[pendingUserInputQuestionIndex];
        if (!question || !prompt.trim()) return false;
        const nextAnswers = {
          ...pendingUserInputAnswers,
          [question.id]: { customAnswer: prompt.trim() },
        };
        setPendingUserInputAnswers(nextAnswers);
        if (pendingUserInputQuestionIndex < pendingUserInput.questions.length - 1) {
          setPendingUserInputQuestionIndex((index) => index + 1);
          return true;
        }
        const answers = buildPendingUserInputAnswers(pendingUserInput.questions, nextAnswers);
        if (!answers) return false;
        return submitPendingUserInput(pendingUserInput.requestId, answers);
      }
      if (!botReady) {
        setError(localFailure("The bot is still connecting."));
        return Promise.resolve(false);
      }
      if (!activeProject) {
        setError(localFailure("Your workspace is still loading. Try again in a moment."));
        return Promise.resolve(false);
      }
      const unsupported = files.find((file) => resolveBotFileAttachment(file) === null);
      if (unsupported) {
        setError(localFailure(`This file type is not supported: ${unsupported.name}`));
        return Promise.resolve(false);
      }

      const pendingNewChat = pendingNewChatRef.current;
      queuedSendCountRef.current += 1;
      setSending(true);
      setError(null);
      return sendQueueRef.current.enqueue(async () => {
        setError(null);
        const createdAt = new Date().toISOString();
        const modelSelection: ModelSelection =
          effectiveModelSelection ??
          activeProject.defaultModelSelection ??
          appDefaultModelSelection;
        const runtimeMode = bot?.runtimeMode ?? settings.localExecutionMode;
        const title = threadTitle(prompt, files);

        try {
          const attachments = await Promise.all(
            files.map(async (file) => {
              const attachment = resolveBotFileAttachment(file);
              if (!attachment) throw new Error(`This file type is not supported: ${file.name}`);
              return {
                ...attachment,
                name: file.name,
                sizeBytes: file.size,
                dataUrl: await readFileAsDataUrl(file, attachment.mimeType),
              };
            }),
          );
          const newChatRef = pendingNewChat ? await pendingNewChat : null;
          if (pendingNewChat && !newChatRef) {
            setError(localFailure("Could not start a new chat."));
            return false;
          }
          const currentThreadRef =
            newChatRef ??
            retainedThreadRef.current.threadRef ??
            (await ensureTranscriptThread(title));
          if (!currentThreadRef) {
            setError(localFailure("Could not send the message."));
            return false;
          }
          if (
            files.some((file) => resolveBotFileAttachment(file)?.type === "file") &&
            !readEnvironmentSupportsFileAttachments(activeProject.environmentId)
          ) {
            setError(localFailure("Update the connected Akeru server to attach files."));
            return false;
          }
          if (rememberedThread && rememberedThread.runtimeMode !== runtimeMode) {
            const modeResult = await setRuntimeMode({
              environmentId: currentThreadRef.environmentId,
              input: { threadId: currentThreadRef.threadId, runtimeMode },
            });
            if (modeResult._tag === "Failure") {
              setError(commandFailure(modeResult));
              return false;
            }
          }
          const startResult = await startTurn({
            environmentId: currentThreadRef.environmentId,
            input: buildBotTurnStartInput({
              botId: BotId.make(botId),
              threadId: currentThreadRef.threadId,
              projectId: activeProject.id,
              title,
              message: {
                messageId: voiceMessageId ?? newMessageId(),
                role: "user",
                text: prompt,
                attachments,
              },
              modelSelection,
              runtimeMode,
              interactionMode: DEFAULT_INTERACTION_MODE,
              createdAt,
              createThread: false,
            }),
          });
          if (startResult._tag === "Failure") {
            setError(commandFailure(startResult));
            return false;
          }
          const shellTitle = threadShellsRef.current.find(
            (shell) => shell.id === currentThreadRef.threadId,
          )?.title;
          if (
            shouldTitlePlaceholderChat(
              currentThreadRef.threadId,
              shellTitle,
              placeholderChatIdRef.current,
              titledChatIdRef.current,
            )
          ) {
            const titledChatId = currentThreadRef.threadId;
            if (placeholderChatIdRef.current === titledChatId) {
              placeholderChatIdRef.current = null;
            }
            titledChatIdRef.current = titledChatId;
            // Best effort: the turn already started, so a failed rename only keeps the
            // placeholder, and the next send may try again.
            void updateMetadata({
              environmentId: currentThreadRef.environmentId,
              input: { threadId: titledChatId, title },
            }).then((result) => {
              if (result._tag === "Failure" && titledChatIdRef.current === titledChatId) {
                titledChatIdRef.current = null;
              }
            });
          }

          if (retainedThreadRef.current.threadRef !== currentThreadRef) {
            retainedThreadRef.current = {
              ownerId: botId,
              threadRef: currentThreadRef,
              linked: false,
            };
          }
          useRosterStore
            .getState()
            .recordChatPath(
              botId,
              `/${currentThreadRef.environmentId}/${currentThreadRef.threadId}`,
            );
          useRosterStore.getState().recordLastMessage(botId, {
            text: prompt || (files.length === 1 ? "Sent an image" : "Sent images"),
            at: createdAt,
            threadId: currentThreadRef.threadId,
          });
          return true;
        } catch (cause) {
          setError(
            localFailure(cause instanceof Error ? cause.message : "Could not send the message."),
          );
          return false;
        } finally {
          queuedSendCountRef.current -= 1;
          if (queuedSendCountRef.current === 0) setSending(false);
        }
      });
    },
    [
      activeProject,
      appDefaultModelSelection,
      bot,
      botId,
      effectiveModelSelection,
      botReady,
      ensureTranscriptThread,
      rememberedThread?.runtimeMode,
      settings.localExecutionMode,
      setRuntimeMode,
      linkedThreadRef,
      pendingUserInputAnswers,
      pendingUserInputQuestionIndex,
      pendingUserInputs,
      respondToUserInputCommand,
      respondingRequestIds,
      submitPendingUserInput,
      startTurn,
      updateMetadata,
    ],
  );

  /** Sends a call utterance as a chat turn and returns its message id for reply correlation. */
  const sendVoiceMessage = useCallback(
    async (text: string): Promise<MessageId | null> => {
      const messageId = newMessageId();
      return (await send(text, [], messageId)) ? messageId : null;
    },
    [send],
  );

  const appendTranscript = useCallback(
    async (role: "user" | "assistant", text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      const threadRef = retainedThreadRef.current.threadRef ?? (await ensureTranscriptThread());
      if (!threadRef) return;
      void appendVoiceTranscript({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          messageId: newMessageId(),
          role,
          text: trimmed,
          ...(role === "assistant" ? { respondingBotId: BotId.make(botId) } : {}),
        },
      });
    },
    [appendVoiceTranscript, botId, ensureTranscriptThread],
  );

  useEffect(() => {
    setPendingUserInputAnswers({});
    setPendingUserInputQuestionIndex(0);
    singleSelectInFlightRef.current = null;
    const pendingIds = new Set(pendingUserInputs.map((pending) => pending.requestId));
    for (const requestId of respondingRequestIdsRef.current) {
      if (!pendingIds.has(requestId)) respondingRequestIdsRef.current.delete(requestId);
    }
    setRespondingRequestIds((current) => current.filter((requestId) => pendingIds.has(requestId)));
  }, [pendingUserInputs[0]?.requestId]);

  const selectPendingUserInputOption = useCallback(
    (questionId: string, optionLabel: string) => {
      const pending = pendingUserInputs[0];
      const question = pending?.questions.find((entry) => entry.id === questionId);
      if (!pending || !question) return;
      if (!question.multiSelect) {
        const selectionKey = `${pending.requestId}:${questionId}`;
        if (singleSelectInFlightRef.current === selectionKey) return;
        const selection = applyPendingUserInputSingleSelect(
          pending.questions,
          pendingUserInputAnswers,
          pendingUserInputQuestionIndex,
          questionId,
          optionLabel,
        );
        if (!selection) return;
        singleSelectInFlightRef.current = selectionKey;
        setPendingUserInputAnswers(selection.draftAnswers);
        if (!selection.answers) {
          setPendingUserInputQuestionIndex(selection.questionIndex);
          return;
        }
        void submitPendingUserInput(pending.requestId, selection.answers).then((submitted) => {
          if (!submitted) singleSelectInFlightRef.current = null;
        });
        return;
      }
      setPendingUserInputAnswers((current) => ({
        ...current,
        [questionId]: togglePendingUserInputOptionSelection(
          question,
          current[questionId],
          optionLabel,
        ),
      }));
    },
    [
      pendingUserInputAnswers,
      pendingUserInputQuestionIndex,
      pendingUserInputs,
      submitPendingUserInput,
    ],
  );

  const advancePendingUserInput = useCallback(async () => {
    const pending = pendingUserInputs[0];
    if (!pending || !linkedThreadRef || respondingRequestIds.includes(pending.requestId)) return;
    if (pendingUserInputQuestionIndex < pending.questions.length - 1) {
      setPendingUserInputQuestionIndex((index) => index + 1);
      return;
    }
    const answers = buildPendingUserInputAnswers(pending.questions, pendingUserInputAnswers);
    if (!answers) return;
    await submitPendingUserInput(pending.requestId, answers);
  }, [
    linkedThreadRef,
    pendingUserInputAnswers,
    pendingUserInputQuestionIndex,
    pendingUserInputs,
    respondingRequestIds,
    submitPendingUserInput,
  ]);

  const lastUserMessageAt = messages?.findLast((message) => message.role === "user")?.createdAt;
  const session = rememberedThread?.session ?? null;
  const turnFailure = latestBotThreadFailure({
    activities,
    latestTurn: rememberedThread?.latestTurn ?? null,
    session,
    lastUserMessageAt: lastUserMessageAt ?? null,
  });
  const failure: BotThreadFailure | null =
    error ??
    turnFailure ??
    (session?.lastError
      ? { message: session.lastError, unavailability: session.unavailability ?? null }
      : null);

  return {
    appendTranscript,
    bootstrapped,
    botReady,
    canResume,
    defaultProject: activeProject,
    error: failure?.message ?? null,
    failure,
    turnFailure,
    linkedThreadRef,
    latestTurn: rememberedThread?.latestTurn ?? null,
    messages,
    pendingUserInputs,
    pendingUserInputAnswers,
    pendingUserInputQuestionIndex,
    respondingRequestIds,
    resume,
    resuming,
    selectPendingUserInputOption,
    advancePendingUserInput,
    canStartNewChat,
    send,
    sendVoiceMessage,
    sending,
    startNewChat,
  };
}
