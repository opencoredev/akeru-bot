import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  BotId,
  EnvironmentId,
  ThreadId,
  type ModelSelection,
  type ProviderApprovalDecision,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useCallback, useMemo, useRef, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { DEFAULT_INTERACTION_MODE } from "../../types";
import { newMessageId, newThreadId } from "../../lib/utils";
import { resolveAppModelSelectionState } from "../../modelSelection";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
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
import { derivePendingApprovals } from "../../session-logic";
import { sortScopedProjectsForSidebar } from "../Sidebar.logic";
import { resolveBotRuntimeMode } from "./botSandbox";
import {
  buildBotTurnStartInput,
  createBotTurnSubmissionQueue,
  joinOrStartThreadCreate,
  resolveBotThreadTarget,
} from "./botThreadRuntime.logic";
import { parseChatPath } from "./roster.logic";
import { useRosterStore } from "./rosterStore";

const NO_ENVIRONMENT = "" as EnvironmentId;

function errorMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "Could not send the message.";
}

function threadTitle(prompt: string, files: readonly File[]): string {
  const seed = prompt || (files[0] ? `Image: ${files[0].name}` : "New thread");
  return seed.length > 80 ? `${seed.slice(0, 79)}…` : seed;
}

function readFileAsDataUrl(file: File): Promise<string> {
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
          ? resolve(reader.result)
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
  const pendingApprovals = useMemo(() => derivePendingApprovals(activities), [activities]);
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
  const [error, setError] = useState<string | null>(null);

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
    (prompt: string, files: readonly File[]): Promise<boolean> => {
      if (!botReady) {
        setError("The bot is still connecting.");
        return Promise.resolve(false);
      }
      if (!activeProject) {
        setError("Add a project before you message a bot.");
        return Promise.resolve(false);
      }
      const unsupported = files.find((file) => !file.type.startsWith("image/"));
      if (unsupported) {
        setError("Bot attachments must be images.");
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
            files.map(async (file) => ({
              type: "image" as const,
              name: file.name,
              mimeType: file.type,
              sizeBytes: file.size,
              dataUrl: await readFileAsDataUrl(file),
            })),
          );
          const currentThreadRef =
            retainedThreadRef.current.threadRef ?? (await ensureTranscriptThread(title));
          if (!currentThreadRef) {
            setError("Could not send the message.");
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
    respondToApproval,
    respondingToApproval,
    send,
    sending,
  };
}
