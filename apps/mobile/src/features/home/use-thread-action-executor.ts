import type { EnvironmentThreadShell } from "@akeru/client-runtime/state/shell";
import { canSettle } from "@akeru/client-runtime/state/thread-settled";
import * as Cause from "effect/Cause";
import * as Haptics from "expo-haptics";
import { useCallback, useRef } from "react";
import { Alert } from "react-native";
import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { useMobileI18n } from "../../lib/i18n";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { refreshArchivedThreadsForEnvironment } from "../archive/useArchivedThreadSnapshots";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { environmentSupportsThreadCapability } from "./environment-thread-capabilities";

export type ThreadListAction = "archive" | "unarchive" | "delete" | "settle" | "unsettle";
type Translate = ReturnType<typeof useMobileI18n>["t"];

function actionFailureMessage(
  action: ThreadListAction,
  cause: Cause.Cause<unknown>,
  t: Translate,
): string {
  const error = Cause.squash(cause);
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (action === "archive") return t("The chat could not be archived.");
  if (action === "unarchive") return t("The chat could not be unarchived.");
  if (action === "settle") return t("The chat could not be settled.");
  if (action === "unsettle") return t("The chat could not be un-settled.");
  return t("The chat could not be deleted.");
}

export function selectionHaptic(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

function actionFailureTitle(action: ThreadListAction, t: Translate): string {
  if (action === "archive") return t("Could not archive chat");
  if (action === "unarchive") return t("Could not unarchive chat");
  if (action === "settle") return t("Could not settle chat");
  if (action === "unsettle") return t("Could not un-settle chat");
  return t("Could not delete chat");
}

/** Resolves to true iff the action was dispatched and succeeded. */
export function useThreadActionExecutor(
  onCompleted?: (action: ThreadListAction, thread: EnvironmentThreadShell) => void,
) {
  const { t } = useMobileI18n();
  const archiveMutation = useAtomCommand(threadEnvironment.archive, { reportFailure: false });
  const unarchiveMutation = useAtomCommand(threadEnvironment.unarchive, { reportFailure: false });
  const deleteMutation = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const settleMutation = useAtomCommand(threadEnvironment.settle, { reportFailure: false });
  const unsettleMutation = useAtomCommand(threadEnvironment.unsettle, { reportFailure: false });
  const inFlightThreadKeys = useRef(new Set<string>());

  const executeAction = useCallback(
    async (action: ThreadListAction, thread: EnvironmentThreadShell) => {
      const key = scopedThreadKey(thread.environmentId, thread.id);
      if (inFlightThreadKeys.current.has(key)) {
        return false;
      }

      inFlightThreadKeys.current.add(key);
      selectionHaptic();
      try {
        if (
          (action === "settle" || action === "unsettle") &&
          !environmentSupportsThreadCapability(thread.environmentId, "threadSettlement")
        ) {
          Alert.alert(
            actionFailureTitle(action, t),
            t(
              "This environment's server does not support settling yet. Update the server to use Settle.",
            ),
          );
          return false;
        }
        // Settle may only target what effectiveSettled could classify as
        // settled: not starting/running sessions, not threads waiting on
        // approvals or user input. Anything else would hide live work.
        if (action === "settle" && !canSettle(thread, { now: new Date().toISOString() })) {
          Alert.alert(
            actionFailureTitle(action, t),
            t("This chat still needs attention. Resolve or interrupt it first, then try again."),
          );
          return false;
        }
        // Archive keeps its original, narrower guard: never interrupt a
        // thread mid-turn.
        if (
          action === "archive" &&
          thread.session?.status === "running" &&
          thread.session.activeTurnId != null
        ) {
          Alert.alert(
            actionFailureTitle(action, t),
            t("This chat is working. Interrupt it first, then try again."),
          );
          return false;
        }
        const result =
          action === "unsettle"
            ? await unsettleMutation({
                environmentId: thread.environmentId,
                input: { threadId: thread.id, reason: "user" },
              })
            : await (
                action === "settle"
                  ? settleMutation
                  : action === "archive"
                    ? archiveMutation
                    : action === "unarchive"
                      ? unarchiveMutation
                      : deleteMutation
              )({
                environmentId: thread.environmentId,
                input: { threadId: thread.id },
              });
        if (result._tag === "Failure") {
          Alert.alert(actionFailureTitle(action, t), actionFailureMessage(action, result.cause, t));
          return false;
        }
        // Settled threads stay in the live shell stream; only the archive
        // lifecycle still feeds the archived-snapshot surface.
        if (action === "archive" || action === "unarchive" || action === "delete") {
          refreshArchivedThreadsForEnvironment(thread.environmentId);
        }
        onCompleted?.(action, thread);
        return true;
      } finally {
        inFlightThreadKeys.current.delete(key);
      }
    },
    [
      archiveMutation,
      deleteMutation,
      onCompleted,
      settleMutation,
      t,
      unarchiveMutation,
      unsettleMutation,
    ],
  );

  return executeAction;
}

export function useConfirmDeleteThread(
  executeAction: (action: ThreadListAction, thread: EnvironmentThreadShell) => Promise<boolean>,
) {
  const { t } = useMobileI18n();
  return useCallback(
    (thread: EnvironmentThreadShell) => {
      const title = t("Delete chat?");
      const message = t("“{title}” will be permanently deleted, including its terminal history.", {
        title: thread.title,
      });
      if (process.env.EXPO_OS === "ios") {
        Alert.alert(title, message, [
          { text: t("Cancel"), style: "cancel" },
          {
            text: t("Delete"),
            style: "destructive",
            onPress: () => {
              void executeAction("delete", thread);
            },
          },
        ]);
        return;
      }
      showConfirmDialog({
        title,
        message,
        confirmText: t("Delete"),
        destructive: true,
        onConfirm: () => {
          void executeAction("delete", thread);
        },
      });
    },
    [executeAction, t],
  );
}
