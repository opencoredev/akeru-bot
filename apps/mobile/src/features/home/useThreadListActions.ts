import type { EnvironmentThreadShell } from "@akeru/client-runtime/state/shell";
import { canSnooze } from "@akeru/client-runtime/state/thread-settled";
import * as Cause from "effect/Cause";
import { useCallback, useRef } from "react";
import { Alert } from "react-native";
import { useMobileI18n } from "../../lib/i18n";
import { scopedThreadKey } from "../../lib/scopedEntities";
import {
  pinOrderKeyBetween,
  planPinnedMove,
  sortPinnedThreadsByOrderKey,
} from "@akeru/client-runtime/state/thread-sort";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  type ThreadListAction,
  selectionHaptic,
  useConfirmDeleteThread,
  useThreadActionExecutor,
} from "./use-thread-action-executor";
import { environmentSupportsThreadCapability } from "./environment-thread-capabilities";

export function useThreadListActions(): {
  readonly archiveThread: (thread: EnvironmentThreadShell) => void;
  readonly confirmDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly settleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly snoozeThread: (thread: EnvironmentThreadShell, snoozedUntil: string) => Promise<boolean>;
  readonly unsnoozeThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly unsettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly pinThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly unpinThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly movePinnedThread: (
    thread: EnvironmentThreadShell,
    direction: "up" | "down",
  ) => Promise<boolean>;
  readonly regenerateThreadTitle: (thread: EnvironmentThreadShell) => Promise<boolean>;
} {
  const { t } = useMobileI18n();
  const executeAction = useThreadActionExecutor();
  const snoozeMutation = useAtomCommand(threadEnvironment.snooze, { reportFailure: false });
  const unsnoozeMutation = useAtomCommand(threadEnvironment.unsnooze, { reportFailure: false });
  const pinMutation = useAtomCommand(threadEnvironment.pin, { reportFailure: false });
  const unpinMutation = useAtomCommand(threadEnvironment.unpin, { reportFailure: false });
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const snoozeInFlightThreadKeys = useRef(new Set<string>());
  const titleRegenerationInFlightThreadKeys = useRef(new Set<string>());

  const archiveThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void executeAction("archive", thread);
    },
    [executeAction],
  );
  const settleThread = useCallback(
    async (thread: EnvironmentThreadShell) => (await executeAction("settle", thread)) === true,
    [executeAction],
  );
  const snoozeThread = useCallback(
    async (thread: EnvironmentThreadShell, snoozedUntil: string) => {
      const key = scopedThreadKey(thread.environmentId, thread.id);
      if (snoozeInFlightThreadKeys.current.has(key)) {
        return false;
      }
      snoozeInFlightThreadKeys.current.add(key);
      try {
        if (!environmentSupportsThreadCapability(thread.environmentId, "threadSnooze")) {
          Alert.alert(
            t("Could not snooze chat"),
            t(
              "This environment's server does not support snoozing yet. Update the server to use Snooze.",
            ),
          );
          return false;
        }
        if (!canSnooze(thread, { now: new Date().toISOString() })) {
          Alert.alert(
            t("Could not snooze chat"),
            thread.hasPendingApprovals || thread.hasPendingUserInput
              ? t("This chat is waiting on you. Respond to the pending request before snoozing it.")
              : t("This chat is still starting a turn. Try again once it's running."),
          );
          return false;
        }

        selectionHaptic();
        const result = await snoozeMutation({
          environmentId: thread.environmentId,
          input: {
            threadId: thread.id,
            snoozedUntil,
          },
        });
        if (result._tag === "Failure") {
          const error = Cause.squash(result.cause);
          Alert.alert(
            t("Could not snooze chat"),
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : t("The chat could not be snoozed."),
          );
          return false;
        }
        return true;
      } finally {
        snoozeInFlightThreadKeys.current.delete(key);
      }
    },
    [snoozeMutation, t],
  );
  const unsnoozeThread = useCallback(
    async (thread: EnvironmentThreadShell) => {
      const key = scopedThreadKey(thread.environmentId, thread.id);
      if (snoozeInFlightThreadKeys.current.has(key)) {
        return false;
      }
      snoozeInFlightThreadKeys.current.add(key);
      try {
        if (!environmentSupportsThreadCapability(thread.environmentId, "threadSnooze")) {
          Alert.alert(
            t("Could not wake chat"),
            t(
              "This environment's server does not support snoozing yet. Update the server to wake this chat.",
            ),
          );
          return false;
        }

        selectionHaptic();
        const result = await unsnoozeMutation({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, reason: "user" },
        });
        if (result._tag === "Failure") {
          const error = Cause.squash(result.cause);
          Alert.alert(
            t("Could not wake chat"),
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : t("The chat could not be woken."),
          );
          return false;
        }
        return true;
      } finally {
        snoozeInFlightThreadKeys.current.delete(key);
      }
    },
    [unsnoozeMutation, t],
  );
  const unsettleThread = useCallback(
    async (thread: EnvironmentThreadShell) => (await executeAction("unsettle", thread)) === true,
    [executeAction],
  );
  const pinThread = useCallback(
    async (thread: EnvironmentThreadShell) => {
      if (!environmentSupportsThreadCapability(thread.environmentId, "threadPinning")) {
        Alert.alert(
          t("Could not pin chat"),
          t(
            "This environment's server does not support pinning yet. Update the server to use Pin.",
          ),
        );
        return false;
      }
      selectionHaptic();
      // Same placement as web: a fresh pin takes the top of the arranged
      // run. Servers that predate reordering get the bare pin (keyless).
      let orderKey: string | undefined;
      if (environmentSupportsThreadCapability(thread.environmentId, "threadPinReorder")) {
        const shells = appAtomRegistry.get(environmentThreadShells.threadShellsAtom);
        let firstKey: string | null = null;
        for (const shell of shells) {
          if (shell.pinnedAt == null || shell.pinOrderKey == null) continue;
          if (firstKey === null || shell.pinOrderKey < firstKey) firstKey = shell.pinOrderKey;
        }
        orderKey = pinOrderKeyBetween(null, firstKey) ?? undefined;
      }
      const result = await pinMutation({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, ...(orderKey !== undefined ? { orderKey } : {}) },
      });
      if (result._tag === "Failure") {
        const error = Cause.squash(result.cause);
        Alert.alert(
          t("Could not pin chat"),
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : t("The chat could not be pinned."),
        );
        return false;
      }
      return true;
    },
    [pinMutation, t],
  );
  const unpinThread = useCallback(
    async (thread: EnvironmentThreadShell) => {
      if (!environmentSupportsThreadCapability(thread.environmentId, "threadPinning")) {
        Alert.alert(
          t("Could not unpin chat"),
          t(
            "This environment's server does not support pinning yet. Update the server to use Pin.",
          ),
        );
        return false;
      }
      selectionHaptic();
      const result = await unpinMutation({
        environmentId: thread.environmentId,
        input: { threadId: thread.id },
      });
      if (result._tag === "Failure") {
        const error = Cause.squash(result.cause);
        Alert.alert(
          t("Could not unpin chat"),
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : t("The chat could not be unpinned."),
        );
        return false;
      }
      return true;
    },
    [unpinMutation, t],
  );
  const regenerateThreadTitle = useCallback(
    async (thread: EnvironmentThreadShell) => {
      const key = scopedThreadKey(thread.environmentId, thread.id);
      if (
        thread.titleRegeneration != null ||
        titleRegenerationInFlightThreadKeys.current.has(key)
      ) {
        return false;
      }
      if (!environmentSupportsThreadCapability(thread.environmentId, "threadTitleRegeneration")) {
        Alert.alert(
          t("Could not regenerate title"),
          t(
            "This environment's server does not support title regeneration yet. Update the server to regenerate chat titles.",
          ),
        );
        return false;
      }

      titleRegenerationInFlightThreadKeys.current.add(key);
      selectionHaptic();
      try {
        const result = await updateThreadMetadata({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, regenerateTitle: true },
        });
        if (result._tag === "Failure") {
          const error = Cause.squash(result.cause);
          Alert.alert(
            t("Could not regenerate title"),
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : t("The chat title could not be regenerated."),
          );
          return false;
        }
        return true;
      } finally {
        titleRegenerationInFlightThreadKeys.current.delete(key);
      }
    },
    [updateThreadMetadata, t],
  );

  // Move up / Move down for the pinned block. Computed against the CANONICAL
  // keyed pinned order (not the rendered list), so the move is valid even
  // while search or a project scope filters rows: the same fractional-key
  // scheme web dragging uses, one write to one thread per move (plus a
  // one-time section materialization when legacy keyless pins are involved).
  const reorderPinnedMutation = useAtomCommand(threadEnvironment.reorderPin, {
    reportFailure: false,
  });
  // One move at a time: a second tap before the first write's event lands
  // would plan from the same stale snapshot and silently collapse two moves
  // into one — same double-dispatch guard as snoozeThread.
  const movePinnedInFlightRef = useRef(false);
  const movePinnedThread = useCallback(
    async (thread: EnvironmentThreadShell, direction: "up" | "down") => {
      if (movePinnedInFlightRef.current) return false;
      if (!environmentSupportsThreadCapability(thread.environmentId, "threadPinReorder")) {
        Alert.alert(
          t("Could not move chat"),
          t(
            "This environment's server does not support pinned reordering yet. Update the server to reorder pins.",
          ),
        );
        return false;
      }
      const shells = appAtomRegistry.get(environmentThreadShells.threadShellsAtom);
      const pinned = sortPinnedThreadsByOrderKey(
        shells.filter(
          (shell) =>
            shell.pinnedAt != null &&
            shell.archivedAt === null &&
            environmentSupportsThreadCapability(shell.environmentId, "threadPinReorder"),
        ),
      );
      const orderedIds = pinned.map((shell) => scopedThreadKey(shell.environmentId, shell.id));
      const assignments = planPinnedMove({
        orderedIds,
        keysById: new Map(
          pinned.map((shell) => [
            scopedThreadKey(shell.environmentId, shell.id),
            shell.pinOrderKey ?? null,
          ]),
        ),
        movedId: scopedThreadKey(thread.environmentId, thread.id),
        direction,
      });
      if (assignments === null || assignments.length === 0) return false;
      const shellByKey = new Map(
        pinned.map((shell) => [scopedThreadKey(shell.environmentId, shell.id), shell]),
      );
      selectionHaptic();
      movePinnedInFlightRef.current = true;
      try {
        for (const assignment of assignments) {
          const target = shellByKey.get(assignment.id);
          if (target === undefined) continue;
          const result = await reorderPinnedMutation({
            environmentId: target.environmentId,
            input: { threadId: target.id, orderKey: assignment.orderKey },
          });
          if (result._tag === "Failure") {
            const error = Cause.squash(result.cause);
            Alert.alert(
              t("Could not move chat"),
              error instanceof Error && error.message.trim().length > 0
                ? error.message
                : t("The pinned chat could not be moved."),
            );
            // No rollback: keys already written are valid orderings on their
            // own (each write is a complete, consistent placement), so a
            // partial materialization leaves the list sensible, not corrupt.
            return false;
          }
        }
        return true;
      } finally {
        movePinnedInFlightRef.current = false;
      }
    },
    [reorderPinnedMutation, t],
  );

  const confirmDeleteThread = useConfirmDeleteThread(executeAction);

  return {
    archiveThread,
    confirmDeleteThread,
    settleThread,
    snoozeThread,
    unsnoozeThread,
    unsettleThread,
    pinThread,
    unpinThread,
    movePinnedThread,
    regenerateThreadTitle,
  };
}

export function useArchivedThreadListActions(
  onCompleted: (thread: EnvironmentThreadShell) => void,
): {
  readonly unarchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly confirmDeleteThread: (thread: EnvironmentThreadShell) => void;
} {
  const handleCompleted = useCallback(
    (_action: ThreadListAction, thread: EnvironmentThreadShell) => {
      onCompleted(thread);
    },
    [onCompleted],
  );
  const executeAction = useThreadActionExecutor(handleCompleted);
  const unarchiveThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void executeAction("unarchive", thread);
    },
    [executeAction],
  );
  const confirmDeleteThread = useConfirmDeleteThread(executeAction);

  return { unarchiveThread, confirmDeleteThread };
}
