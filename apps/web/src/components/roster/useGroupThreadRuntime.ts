import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  BotId,
  EnvironmentId,
  GroupId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useCallback, useMemo, useRef, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { newMessageId, newThreadId } from "../../lib/utils";
import { resolveAppModelSelectionState } from "../../modelSelection";
import { environmentGroupsAtom } from "../../state/bots";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadMessages,
  useThreadShell,
  useThreadShells,
} from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerProvidersAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { DEFAULT_INTERACTION_MODE } from "../../types";
import { sortScopedProjectsForSidebar } from "../Sidebar.logic";
import { resolveBotRuntimeMode } from "./botSandbox";
import { buildGroupTurnStartInput, findLatestGroupThreadTarget } from "./botThreadRuntime.logic";
import { groupContainsBot } from "./roster.logic";
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
  const groupReady = serverGroups.some((candidate) => candidate.id === groupId);
  const sendInFlightRef = useRef(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback(
    async (prompt: string, files: readonly File[], requestedBotId?: string): Promise<boolean> => {
      if (sendInFlightRef.current) return false;
      if (!groupReady || !group) {
        setError("The group is still connecting.");
        return false;
      }
      if (!activeProject) {
        setError("Add a project before you message a group.");
        return false;
      }
      const unsupported = files.find((file) => !file.type.startsWith("image/"));
      if (unsupported) {
        setError("Group attachments must be images.");
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
          files.map(async (file) => ({
            type: "image" as const,
            name: file.name,
            mimeType: file.type,
            sizeBytes: file.size,
            dataUrl: await readFileAsDataUrl(file),
          })),
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
      rememberedThread?.runtimeMode,
      settings.localExecutionMode,
      setRuntimeMode,
      startTurn,
    ],
  );

  return {
    bootstrapped,
    defaultProject: activeProject,
    error,
    groupReady,
    linkedThreadRef,
    messages,
    respondingBotId: rememberedThread?.respondingBotId ?? group?.bossBotId ?? null,
    send,
    sending,
  };
}
