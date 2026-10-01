import { BotId } from "@akeru/contracts";
import { ArchiveRestoreIcon, ChevronDownIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";
import { botEnvironment } from "../../state/bots";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { SidebarGroup } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BotAvatarView } from "./BotAvatarView";
import { archivedRosterBots } from "./roster.logic";
import { commandFailureMessage } from "./rosterCommands.logic";
import type { Bot } from "./types";

/** Collapsible list of archived bots under the roster, each with a restore action. */
export function RosterArchivedSection({ bots }: { bots: readonly Bot[] }) {
  const { t } = useI18n();
  const environmentId = usePrimaryEnvironmentId();
  const restoreBotCommand = useAtomCommand(botEnvironment.restore, { reportFailure: false });
  const archivedBots = useMemo(() => archivedRosterBots(bots), [bots]);
  const [archivedOpen, setArchivedOpen] = useState(false);

  const handleRestoreBot = async (bot: Bot) => {
    if (environmentId === null) {
      toastManager.add({ type: "error", title: t("Connect an environment first") });
      return;
    }
    const result = await restoreBotCommand({
      environmentId,
      input: { botId: BotId.make(bot.id) },
    });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: t("Could not restore {name}", { name: bot.name }),
        description: commandFailureMessage(result, t),
      });
    }
  };

  if (archivedBots.length === 0) return null;
  return (
    <SidebarGroup
      data-testid="roster-archived"
      className="px-[var(--sidebar-content-inset)] pb-1 pt-1 group-data-[collapsible=icon]:hidden"
    >
      <button
        type="button"
        aria-expanded={archivedOpen}
        onClick={() => setArchivedOpen((open) => !open)}
        className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-sidebar-muted-foreground outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDownIcon
          className={cn("size-3.5 transition-transform", !archivedOpen && "-rotate-90")}
        />
        <span>{t("Archived")}</span>
        <span
          className="tabular-nums"
          aria-label={t("{count} archived", { count: archivedBots.length })}
        >
          {archivedBots.length}
        </span>
      </button>
      {archivedOpen ? (
        <ul role="list" aria-label={t("Archived bots")} className="flex flex-col gap-px">
          {archivedBots.map((bot) => (
            <li
              key={bot.id}
              className="flex list-none items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-sidebar-row-hover"
            >
              <BotAvatarView avatar={bot.avatar} name={bot.name} className="size-8 opacity-60" />
              <span className="min-w-0 flex-1 truncate text-sm text-sidebar-muted-foreground">
                {bot.name}
              </span>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={t("Restore {name}", { name: bot.name })}
                      onClick={() => void handleRestoreBot(bot)}
                      className="flex size-7 shrink-0 items-center justify-center rounded-lg text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <ArchiveRestoreIcon className="size-4" />
                    </button>
                  }
                />
                <TooltipPopup side="top">{t("Restore")}</TooltipPopup>
              </Tooltip>
            </li>
          ))}
        </ul>
      ) : null}
    </SidebarGroup>
  );
}
