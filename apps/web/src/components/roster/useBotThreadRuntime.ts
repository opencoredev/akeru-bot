import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  BotId,
  type ApprovalRequestId,
  EnvironmentId,
  ThreadId,
  type ModelSelection,
  type ProviderApprovalDecision,
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
  useThreadShell,
  useThreadShells,
} from "../../state/entities";
import { environmentBotsAtom } from "../../state/bots";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerProvidersAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { derivePendingApprovals, derivePendingUserInputs } from "../../session-logic";
import {
  applyPendingUserInputSingleSelect,
  buildPendingUserInputAnswers,
  type PendingUserInputDraftAnswer,
  togglePendingUserInputOptionSelection,
} from "../../pendingUserInput";
import { sortScopedProjectsForSidebar } from "../Sidebar.logic";
import { resolveBotRuntimeMode } from "./botSandbox";
import {
  buildBotTurnStartInput,
  createBotTurnSubmissionQueue,
  findUnhandledMcpAuthorization,
  joinOrStartThreadCreate,
  resolveBotThreadTarget,
} from "./botThreadRuntime.logic";
import { useRosterStore } from "./rosterStore";
import { ensureLocalApi } from "../../localApi";
import { resolveBotFileAttachment } from "./botFileAttachment";

const NO_ENVIRONMENT = "" as EnvironmentId;

function errorMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "Could not send the message.";
}

function threadTitle(prompt: string, files: readonly File[]): string {
  const seed = prompt || (files[0] ? `File: ${files[0].name}` : "New thread");
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
  const bot = useRosterStore((state) => state.bots.find((candidate) => candidate.id === botId));
  const primaryThreadShells = useMemo(
    () =>
      primaryEnvironmentId
        ? threadShells.filter((thread) => thread.environmentId === primaryEnvironmentId)
        : [],
    [primaryEnvironmentId, threadShells],
  );
  const target = primaryEnvironmentId
    ? resolveBotThreadTarget(botId, primaryEnvironmentId, primaryThreadShells, rememberedPath)
    : null;
  const rememberedThreadRef = useMemo<ScopedThreadRef | null>(() => {
    return target
      ? scopeThreadRef(EnvironmentId.make(target.environmentId), ThreadId.make(target.threadId))
      : null;
  }, [target]);
  const rememberedThread = useThreadShell(rememberedThreadRef);
  const linkedThreadRef = rememberedThread ? rememberedThreadRef : null;
  const retainedThreadRef = useRef<{ botId: string; threadRef: ScopedThreadRef | null }>({
    botId,
    threadRef: null,
  });
  if (retainedThreadRef.current.botId !== botId) {
    retainedThreadRef.current = { botId, threadRef: null };
  }
  if (linkedThreadRef) {
    retainedThreadRef.current.threadRef = linkedThreadRef;
  }
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
  const pendingApprovals = useMemo(() => derivePendingApprovals(activities), [activities]);
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
  const respondToApprovalCommand = useAtomCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondToUserInputCommand = useAtomCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const appendVoiceTranscript = useAtomCommand(threadEnvironment.appendVoiceTranscript, {
    reportFailure: false,
  });
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const ensureThreadRef = useRef<Promise<ScopedThreadRef | null> | null>(null);
  const botReady = serverBots.some((candidate) => candidate.id === botId);
  const sendQueueRef = useRef(createBotTurnSubmissionQueue());
  const queuedSendCountRef = useRef(0);
  const [sending, setSending] = useState(false);
  const [respondingToApproval, setRespondingToApproval] = useState(false);
  const [respondingRequestIds, setRespondingRequestIds] = useState<ApprovalRequestId[]>([]);
  const respondingRequestIdsRef = useRef(new Set<ApprovalRequestId>());
  const singleSelectInFlightRef = useRef<string | null>(null);
  const [pendingUserInputAnswers, setPendingUserInputAnswers] = useState<
    Record<string, PendingUserInputDraftAnswer>
  >({});
  const [pendingUserInputQuestionIndex, setPendingUserInputQuestionIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
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
        setError(errorMessage(result));
        return false;
      }
      return true;
    },
    [linkedThreadRef, respondToUserInputCommand],
  );

  const ensureTranscriptThread = useCallback(
    async (title = `Call with ${bot?.name ?? "bot"}`): Promise<ScopedThreadRef | null> => {
      if (!activeProject || !botReady) return null;
      return joinOrStartThreadCreate({
        getRetained: () => retainedThreadRef.current.threadRef,
        inFlight: ensureThreadRef,
        start: async () => {
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
              runtimeMode: resolveBotRuntimeMode(bot?.sandbox ?? null, settings.localExecutionMode),
              interactionMode: DEFAULT_INTERACTION_MODE,
              branch: null,
              worktreePath: null,
              createdAt: new Date().toISOString(),
            },
          });
          if (result._tag === "Failure") return null;
          const threadRef = scopeThreadRef(activeProject.environmentId, threadId);
          retainedThreadRef.current.threadRef = threadRef;
          useRosterStore
            .getState()
            .recordChatPath(botId, `/${threadRef.environmentId}/${threadRef.threadId}`);
          return threadRef;
        },
      });
    },
    [
      activeProject,
      appDefaultModelSelection,
      bot,
      botId,
      botReady,
      createThread,
      effectiveModelSelection,
      settings.localExecutionMode,
    ],
  );

  const send = useCallback(
    async (prompt: string, files: readonly File[]): Promise<boolean> => {
      const pendingUserInput = pendingUserInputs[0];
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
        setError("The bot is still connecting.");
        return Promise.resolve(false);
      }
      if (!activeProject) {
        setError("Add a project before you message a bot.");
        return Promise.resolve(false);
      }
      const unsupported = files.find((file) => resolveBotFileAttachment(file) === null);
      if (unsupported) {
        setError(`This file type is not supported: ${unsupported.name}`);
        return Promise.resolve(false);
      }

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
        const runtimeMode = resolveBotRuntimeMode(
          bot?.sandbox ?? null,
          settings.localExecutionMode,
        );
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
          const currentThreadRef =
            retainedThreadRef.current.threadRef ?? (await ensureTranscriptThread(title));
          if (!currentThreadRef) {
            setError("Could not send the message.");
            return false;
          }
          if (
            files.some((file) => resolveBotFileAttachment(file)?.type === "file") &&
            !readEnvironmentSupportsFileAttachments(activeProject.environmentId)
          ) {
            setError("Update the connected Akeru server to attach files.");
            return false;
          }
          if (rememberedThread && rememberedThread.runtimeMode !== runtimeMode) {
            const modeResult = await setRuntimeMode({
              environmentId: currentThreadRef.environmentId,
              input: { threadId: currentThreadRef.threadId, runtimeMode },
            });
            if (modeResult._tag === "Failure") {
              setError(errorMessage(modeResult));
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
                messageId: newMessageId(),
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
            setError(errorMessage(startResult));
            return false;
          }

          retainedThreadRef.current.threadRef = currentThreadRef;
          useRosterStore
            .getState()
            .recordChatPath(
              botId,
              `/${currentThreadRef.environmentId}/${currentThreadRef.threadId}`,
            );
          useRosterStore.getState().recordLastMessage(botId, {
            text: prompt || (files.length === 1 ? "Sent an image" : "Sent images"),
            at: createdAt,
          });
          return true;
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Could not send the message.");
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
    ],
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

  const respondToApproval = useCallback(
    async (
      requestId: (typeof pendingApprovals)[number]["requestId"],
      decision: ProviderApprovalDecision,
    ) => {
      if (!linkedThreadRef || respondingToApproval) return;
      setRespondingToApproval(true);
      const result = await respondToApprovalCommand({
        environmentId: linkedThreadRef.environmentId,
        input: { threadId: linkedThreadRef.threadId, requestId, decision },
      });
      setRespondingToApproval(false);
      if (result._tag === "Failure") setError(errorMessage(result));
    },
    [linkedThreadRef, pendingApprovals, respondToApprovalCommand, respondingToApproval],
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

  return {
    appendTranscript,
    bootstrapped,
    botReady,
    defaultProject: activeProject,
    error,
    linkedThreadRef,
    latestTurn: rememberedThread?.latestTurn ?? null,
    messages,
    pendingApprovals,
    pendingUserInputs,
    pendingUserInputAnswers,
    pendingUserInputQuestionIndex,
    respondingRequestIds,
    selectPendingUserInputOption,
    advancePendingUserInput,
    respondToApproval,
    respondingToApproval,
    send,
    sending,
  };
}
