import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { pinOrderKeyBetween } from "@t3tools/client-runtime/state/thread-sort";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { shouldForgetChatPath } from "../components/chat/chatActions.logic";
import { useRosterStore } from "../components/roster/rosterStore";
import { toastManager } from "../components/ui/toast";
import { useI18n } from "../i18n";
import { refreshArchivedThreadsForEnvironment } from "../lib/archivedThreadsState";
import { ensureLocalApi } from "../localApi";
import {
  readEnvironmentSupportsPinReorder,
  readThreadShell,
  readThreadShells,
} from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useUiStateStore } from "../uiStateStore";
import { useClientSettings } from "./useSettings";

/** Key that sorts before every arranged pinned chat, so a fresh pin leads the run. */
function topOfPinnedRunOrderKey(): string | undefined {
  let firstKey: string | null = null;
  for (const shell of readThreadShells()) {
    if (shell.pinnedAt == null || shell.pinOrderKey == null) continue;
    if (firstKey === null || shell.pinOrderKey < firstKey) firstKey = shell.pinOrderKey;
  }
  return pinOrderKeyBetween(null, firstKey) ?? undefined;
}

function input(threadRef: ScopedThreadRef) {
  return { environmentId: threadRef.environmentId, input: { threadId: threadRef.threadId } };
}

/** Drops a bot's remembered chat path when it points at a chat that just left the shell list. */
function forgetRemovedChatPath(threadRef: ScopedThreadRef): void {
  const shell = readThreadShell(threadRef);
  const botId = shell?.botId;
  if (!botId) return;
  const roster = useRosterStore.getState();
  if (shouldForgetChatPath(roster.chatPathByBotId[botId], threadRef)) {
    roster.forgetChatPath(botId);
  }
}

/**
 * Lifecycle commands for one chat, each reporting its own failure. Every call
 * resolves to whether the command landed, so callers can chain follow-ups.
 * Archive and delete also work on chats outside the live shell list, such as
 * those on the archived chats page.
 */
export function useChatActions() {
  const { t } = useI18n();
  const archive = useAtomCommand(threadEnvironment.archive, { reportFailure: false });
  const unarchive = useAtomCommand(threadEnvironment.unarchive, { reportFailure: false });
  const remove = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const settle = useAtomCommand(threadEnvironment.settle, { reportFailure: false });
  const unsettle = useAtomCommand(threadEnvironment.unsettle, { reportFailure: false });
  const snooze = useAtomCommand(threadEnvironment.snooze, { reportFailure: false });
  const unsnooze = useAtomCommand(threadEnvironment.unsnooze, { reportFailure: false });
  const pin = useAtomCommand(threadEnvironment.pin, { reportFailure: false });
  const unpin = useAtomCommand(threadEnvironment.unpin, { reportFailure: false });
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const stopSession = useAtomCommand(threadEnvironment.stopSession, { reportFailure: false });
  const markThreadUnread = useUiStateStore((state) => state.markThreadUnread);
  const confirmThreadDelete = useClientSettings((settings) => settings.confirmThreadDelete);

  const report = useCallback(
    async (
      title: string,
      run: () => Promise<AtomCommandResult<unknown, unknown>>,
    ): Promise<boolean> => {
      const result = await run();
      if (result._tag === "Success") return true;
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title,
          description: error instanceof Error ? error.message : t("An unexpected error occurred."),
        });
      }
      return false;
    },
    [t],
  );

  return useMemo(
    () => ({
      rename: (threadRef: ScopedThreadRef, title: string) =>
        report(t("Could not rename chat"), () =>
          updateMetadata({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId, title },
          }),
        ),
      regenerateTitle: (threadRef: ScopedThreadRef) =>
        report(t("Could not regenerate title"), () =>
          updateMetadata({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId, regenerateTitle: true },
          }),
        ),
      pin: (threadRef: ScopedThreadRef) => {
        const orderKey = readEnvironmentSupportsPinReorder(threadRef.environmentId)
          ? topOfPinnedRunOrderKey()
          : undefined;
        return report(t("Could not pin chat"), () =>
          pin({
            environmentId: threadRef.environmentId,
            input: {
              threadId: threadRef.threadId,
              ...(orderKey !== undefined ? { orderKey } : {}),
            },
          }),
        );
      },
      unpin: (threadRef: ScopedThreadRef) =>
        report(t("Could not unpin chat"), () => unpin(input(threadRef))),
      settle: (threadRef: ScopedThreadRef) =>
        report(t("Could not settle chat"), () => settle(input(threadRef))),
      unsettle: (threadRef: ScopedThreadRef) =>
        report(t("Could not un-settle chat"), () =>
          unsettle({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId, reason: "user" },
          }),
        ),
      snooze: (threadRef: ScopedThreadRef, snoozedUntil: string) =>
        report(t("Could not snooze chat"), () =>
          snooze({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId, snoozedUntil },
          }),
        ),
      unsnooze: (threadRef: ScopedThreadRef) =>
        report(t("Could not wake chat"), () =>
          unsnooze({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId, reason: "user" },
          }),
        ),
      markUnread: (threadRef: ScopedThreadRef) => {
        const completedAt = readThreadShell(threadRef)?.latestTurn?.completedAt;
        markThreadUnread(scopedThreadKey(threadRef), completedAt);
      },
      archive: async (threadRef: ScopedThreadRef) => {
        forgetRemovedChatPath(threadRef);
        const archived = await report(t("Could not archive chat"), () => archive(input(threadRef)));
        if (archived) refreshArchivedThreadsForEnvironment(threadRef.environmentId);
        return archived;
      },
      unarchive: async (threadRef: ScopedThreadRef) => {
        const restored = await report(t("Could not unarchive chat"), () =>
          unarchive(input(threadRef)),
        );
        if (restored) refreshArchivedThreadsForEnvironment(threadRef.environmentId);
        return restored;
      },
      /** Asks first unless the user turned delete confirmation off. */
      delete: async (threadRef: ScopedThreadRef) => {
        if (confirmThreadDelete) {
          const confirmed = await ensureLocalApi().dialogs.confirm(
            t("Delete this chat? This permanently clears the conversation history."),
            { variant: "destructive", confirmLabel: t("Delete chat") },
          );
          if (!confirmed) return false;
        }
        const shell = readThreadShell(threadRef);
        if (shell?.session && shell.session.status !== "stopped") {
          await stopSession(input(threadRef));
        }
        forgetRemovedChatPath(threadRef);
        const deleted = await report(t("Could not delete chat"), () => remove(input(threadRef)));
        if (deleted) refreshArchivedThreadsForEnvironment(threadRef.environmentId);
        return deleted;
      },
    }),
    [
      archive,
      confirmThreadDelete,
      markThreadUnread,
      pin,
      remove,
      report,
      settle,
      snooze,
      stopSession,
      t,
      unarchive,
      unpin,
      unsettle,
      unsnooze,
      updateMetadata,
    ],
  );
}

export type ChatActions = ReturnType<typeof useChatActions>;
