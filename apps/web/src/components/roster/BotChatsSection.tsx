import { relativeRunTime } from "@t3tools/client-runtime/routines";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useMemo } from "react";

import { useActiveChatPaletteActions } from "../../chatActionsRegistry";
import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";
import { useThreadShells } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { Button } from "../ui/button";
import { buildBotChatRows } from "./botChats.logic";
import { listBotChats } from "./botThreadRuntime.logic";
import { useRosterStore } from "./rosterStore";

/**
 * The bot's recent chats in its side panel, newest first, with the open one
 * marked. Opening a row shows that chat in the bot's view; the roster keeps
 * one row per bot. "New chat" runs the open chat's own New chat action, so it
 * is only offered when that chat has something in it.
 */
export function BotChatsSection({
  botId,
  threadRef,
  onOpenChat,
}: {
  readonly botId: string;
  readonly threadRef: ScopedThreadRef | null;
  /** Runs after a row or New chat is chosen, such as closing a narrow sheet. */
  readonly onOpenChat?: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const environmentId = usePrimaryEnvironmentId();
  const shells = useThreadShells();
  const newChat = useActiveChatPaletteActions().find((action) => action.id === "new") ?? null;
  const rows = useMemo(
    () =>
      environmentId
        ? buildBotChatRows({
            chats: listBotChats(botId, environmentId, shells),
            currentThreadId: threadRef?.threadId ?? null,
          })
        : [],
    [botId, environmentId, shells, threadRef?.threadId],
  );
  if (rows.length === 0) return null;
  const now = Date.now();

  return (
    <section className="mt-6" data-bot-chats="">
      <h3 className="text-sm font-medium">{t("Chats")}</h3>
      <ul className="mt-1">
        {rows.map((row) => (
          <li key={row.threadId}>
            {/* Quiet rows: labels line up with the sheet's, only the fill reaches past them. */}
            <Button
              variant="ghost"
              size="sm"
              aria-current={row.current ? "true" : undefined}
              className={cn(
                "-mx-2 w-[calc(100%+1rem)] justify-start gap-3 px-2 font-normal",
                row.current ? "bg-muted text-foreground" : "text-muted-foreground",
              )}
              onClick={() => {
                if (!row.current) {
                  useRosterStore.getState().openBotChat(botId, row.newest ? null : row.threadId);
                }
                onOpenChat?.();
              }}
            >
              <span
                className={cn("min-w-0 flex-1 truncate text-left", row.current && "font-medium")}
              >
                {row.title ?? t("Untitled chat")}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {relativeRunTime(row.updatedAt, now, i18n)}
              </span>
            </Button>
          </li>
        ))}
      </ul>
      {newChat ? (
        <Button
          variant="ghost"
          size="sm"
          className="-mx-2 w-[calc(100%+1rem)] justify-start px-2 text-muted-foreground"
          onClick={() => {
            onOpenChat?.();
            void newChat.run();
          }}
        >
          <PlusIcon aria-hidden />
          {t("New chat")}
        </Button>
      ) : null}
    </section>
  );
}
