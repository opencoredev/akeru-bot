import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  BotId,
  type ApprovalRequestId,
  EnvironmentId,
  GroupId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { newMessageId, newThreadId } from "../../lib/utils";
import { resolveAppModelSelectionState } from "../../modelSelection";
import { environmentGroupsAtom } from "../../state/bots";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  readEnvironmentSupportsFileAttachments,
  useThreadActivities,
  useThreadMessages,
  useThreadShell,
  useThreadShells,
} from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerProvidersAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  applyPendingUserInputSingleSelect,
  buildPendingUserInputAnswers,
  type PendingUserInputDraftAnswer,
  togglePendingUserInputOptionSelection,
} from "../../pendingUserInput";
import { derivePendingUserInputs } from "../../session-logic";
import { DEFAULT_INTERACTION_MODE } from "../../types";
import { sortScopedProjectsForSidebar } from "../Sidebar.logic";
import { resolveBotRuntimeMode } from "./botSandbox";
import { buildGroupTurnStartInput, findLatestGroupThreadTarget } from "./botThreadRuntime.logic";
import { groupContainsBot } from "./roster.logic";
import { useRosterStore } from "./rosterStore";
import { resolveBotFileAttachment } from "./botFileAttachment";

const NO_ENVIRONMENT = "" as EnvironmentId;

function errorMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "Could not send the message.";
}

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

export function useGroupThreadRuntime(groupId: string) {
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const serverGroups = useAtomValue(environmentGroupsAtom(primaryEnvironmentId ?? NO_ENVIRONMENT));
  const threadShells = useThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const settings = usePrimarySettings();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const bots = useRosterStore((state) => state.bots);
  const group = useRosterStore((state) =>
    state.groups.find((candidate) => candidate.id === groupId),
  );
  const primaryThreadShells = useMemo(
    () =>
      primaryEnvironmentId
        ? threadShells.filter((thread) => thread.environmentId === primaryEnvironmentId)
        : [],
    [primaryEnvironmentId, threadShells],
  );
  const serverTarget = primaryEnvironmentId
    ? findLatestGroupThreadTarget(groupId, primaryEnvironmentId, primaryThreadShells)
    : null;
  const rememberedThreadRef = useMemo<ScopedThreadRef | null>(
    () =>
      serverTarget
        ? scopeThreadRef(
            EnvironmentId.make(serverTarget.environmentId),
            ThreadId.make(serverTarget.threadId),
          )
        : null,
    [serverTarget],
  );
  const rememberedThread = useThreadShell(rememberedThreadRef);
  const linkedThreadRef = rememberedThread ? rememberedThreadRef : null;
  const retainedThreadRef = useRef<{ groupId: string; threadRef: ScopedThreadRef | null }>({
    groupId,
    threadRef: null,
  });
  if (retainedThreadRef.current.groupId !== groupId) {
    retainedThreadRef.current = { groupId, threadRef: null };
  }
  if (linkedThreadRef) retainedThreadRef.current.threadRef = linkedThreadRef;
  const messages = useThreadMessages(linkedThreadRef);
  const activities = useThreadActivities(linkedThreadRef);
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
  const respondToUserInputCommand = useAtomCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const groupReady = serverGroups.some((candidate) => candidate.id === groupId);
  const sendInFlightRef = useRef(false);
  const [sending, setSending] = useState(false);
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
        input: { threadId: linkedThreadRef.threadId, requestId, answers },
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

  const send = useCallback(
    async (prompt: string, files: readonly File[], requestedBotId?: string): Promise<boolean> => {
      if (sendInFlightRef.current) return false;
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
      if (!groupReady || !group) {
        setError("The group is still connecting.");
        return false;
      }
      if (!activeProject) {
        setError("Add a project before you message a group.");
        return false;
      }
      const unsupported = files.find((file) => resolveBotFileAttachment(file) === null);
      if (unsupported) {
        setError(`This file type is not supported: ${unsupported.name}`);
        return false;
      }
      if (
        files.some((file) => resolveBotFileAttachment(file)?.type === "file") &&
        !readEnvironmentSupportsFileAttachments(activeProject.environmentId)
      ) {
        setError("Update the connected Akeru server to attach files.");
        return false;
      }

      const respondingBotId = requestedBotId ?? group.bossBotId;
      const respondingBot = bots.find(
        (bot) => bot.id === respondingBotId && groupContainsBot(group, bot.id),
      );
      if (!respondingBot) {
        setError("Choose a current group member.");
        return false;
      }
      const modelSelection: ModelSelection = respondingBot.engine
        ? {
            instanceId: ProviderInstanceId.make(respondingBot.engine.provider),
            model: respondingBot.engine.model,
            ...(respondingBot.engine.options ? { options: respondingBot.engine.options } : {}),
          }
        : (activeProject.defaultModelSelection ?? appDefaultModelSelection);

      sendInFlightRef.current = true;
      setSending(true);
      setError(null);
      const createdAt = new Date().toISOString();
      const currentThreadRef = retainedThreadRef.current.threadRef;
      const threadId = currentThreadRef?.threadId ?? newThreadId();
      const runtimeMode = resolveBotRuntimeMode(respondingBot.sandbox, settings.localExecutionMode);

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
        const environmentId = currentThreadRef?.environmentId ?? activeProject.environmentId;
        if (currentThreadRef && rememberedThread?.runtimeMode !== runtimeMode) {
          const modeResult = await setRuntimeMode({
            environmentId,
            input: { threadId, runtimeMode },
          });
          if (modeResult._tag === "Failure") {
            setError(errorMessage(modeResult));
            return false;
          }
        }
        const result = await startTurn({
          environmentId,
          input: buildGroupTurnStartInput({
            groupId: GroupId.make(groupId),
            respondingBotId: BotId.make(respondingBot.id),
            threadId,
            projectId: activeProject.id,
            title: threadTitle(prompt, files),
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
            createThread: currentThreadRef === null,
          }),
        });
        if (result._tag === "Failure") {
          setError(errorMessage(result));
          return false;
        }
        retainedThreadRef.current.threadRef = scopeThreadRef(environmentId, threadId);
        return true;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not send the message.");
        return false;
      } finally {
        sendInFlightRef.current = false;
        setSending(false);
      }
    },
    [
      activeProject,
      appDefaultModelSelection,
      bots,
      group,
      groupId,
      groupReady,
      linkedThreadRef,
      pendingUserInputAnswers,
      pendingUserInputQuestionIndex,
      pendingUserInputs,
      rememberedThread?.runtimeMode,
      respondingRequestIds,
      settings.localExecutionMode,
      setRuntimeMode,
      startTurn,
      submitPendingUserInput,
    ],
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
    bootstrapped,
    defaultProject: activeProject,
    error,
    groupReady,
    linkedThreadRef,
    messages,
    pendingUserInputs,
    pendingUserInputAnswers,
    pendingUserInputQuestionIndex,
    respondingRequestIds,
    respondingBotId: rememberedThread?.respondingBotId ?? group?.bossBotId ?? null,
    selectPendingUserInputOption,
    advancePendingUserInput,
    send,
    sending,
  };
}
