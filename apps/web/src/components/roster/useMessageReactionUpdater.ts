import type { MessageId, ScopedThreadRef } from "@akeru/contracts";
import { useCallback } from "react";

import { useI18n } from "~/i18n";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import type { MessageReactionOption } from "../chat/MessageControls";
import { toastManager } from "../ui/toast";

export type MessageReactionHandler = (
  messageId: MessageId,
  current: MessageReactionOption | null,
  next: MessageReactionOption | null,
) => void;

/** A stable reaction updater for memoized rows; it only changes with the linked thread. */
export function useMessageReactionUpdater(threadRef: ScopedThreadRef | null) {
  const { t } = useI18n();
  const setMessageReaction = useAtomCommand(threadEnvironment.setMessageReaction, {
    reportFailure: false,
  });
  return useCallback<MessageReactionHandler>(
    (messageId, current, next) => {
      if (!threadRef) return;
      const dispatch = (emoji: MessageReactionOption, present: boolean) =>
        setMessageReaction({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, messageId, emoji, present },
        });
      void (async () => {
        if (current && current !== next) {
          const removed = await dispatch(current, false);
          if (removed._tag === "Failure") {
            toastManager.add({ type: "error", title: t("Could not update reaction") });
            return;
          }
        }
        if (next) {
          const added = await dispatch(next, true);
          if (added._tag === "Failure") {
            toastManager.add({ type: "error", title: t("Could not update reaction") });
          }
        }
      })();
    },
    [setMessageReaction, t, threadRef],
  );
}
