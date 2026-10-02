import { Predicate } from "effect";
import { useAtomValue } from "@effect/atom-react";
import { archivedBotDeletesAtMs, type EnvironmentId, type OrchestrationBot } from "@akeru/contracts";
import { ArchiveRestoreIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useI18n } from "../../i18n";
import { botEnvironment, environmentBotsAtom } from "../../state/bots";
import { useAtomCommand } from "../../state/use-atom-command";
import { BotAvatarView } from "../roster/BotAvatarView";
import { commandFailureMessage } from "../roster/rosterCommands.logic";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Archived bots, newest archive first. Restoring returns a bot to the roster. */
export function archivedBots(bots: readonly OrchestrationBot[]): OrchestrationBot[] {
  return bots
    .filter((bot) => bot.archivedAt !== null)
    .toSorted((left, right) => (right.archivedAt ?? "").localeCompare(left.archivedAt ?? ""));
}

/**
 * Settings > Archived: bots that left the roster. The server deletes each one
 * once its retention window passes, so every row shows that date.
 */
export function ArchivedBotsSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { t, formatDate } = useI18n();
  const bots = useAtomValue(environmentBotsAtom(environmentId));
  const restoreBot = useAtomCommand(botEnvironment.restore, { reportFailure: false });
  const deleteBot = useAtomCommand(botEnvironment.delete, { reportFailure: false });
  const archived = useMemo(() => archivedBots(bots), [bots]);
  const [busyBotId, setBusyBotId] = useState<string | null>(null);

  if (archived.length === 0) return null;

  const handleRestore = async (bot: OrchestrationBot) => {
    setBusyBotId(bot.id);
    const result = await restoreBot({ environmentId, input: { botId: bot.id } });
    setBusyBotId(null);

    if (Predicate.isTagged(result, "Failure")) {
      toastManager.add({
        type: "error",
        title: t("Could not restore {name}", { name: bot.name }),
        description: commandFailureMessage(result, t),
      });
    }
  };

  const handleDelete = async (bot: OrchestrationBot) => {
    const confirmation = requestConfirmDialog(
      t("Delete {name}? Its chats stay in your history. This cannot be undone.", {
        name: bot.name,
      }),
      { variant: "destructive" },
    );

    if (!confirmation || !(await confirmation)) return;
    setBusyBotId(bot.id);
    const result = await deleteBot({ environmentId, input: { botId: bot.id } });
    setBusyBotId(null);

    if (Predicate.isTagged(result, "Failure")) {
      toastManager.add({
        type: "error",
        title: t("Could not delete {name}", { name: bot.name }),
        description: commandFailureMessage(result, t),
      });
    }
  };

  return (
    <SettingsSection id="archived-bots" title={t("Archived bots")}>
      {archived.map((bot) => {
        const busy = busyBotId === bot.id;
        const archivedAt = bot.archivedAt ?? bot.updatedAt;
        const time = formatDate(new Date(archivedAt), { dateStyle: "medium" });

        const date = formatDate(new Date(archivedBotDeletesAtMs(archivedAt)), {
          dateStyle: "medium",
        });

        return (
          <SettingsRow
            key={bot.id}
            data-testid="archived-bot-row"
            title={
              <span className="inline-flex items-center gap-2">
                <BotAvatarView avatar={bot.avatar} name={bot.name} className="size-5" />
                {bot.name}
              </span>
            }
            description={t("Archived {time}. Deleted automatically on {date}.", { time, date })}
            control={
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void handleRestore(bot)}
                >
                  <ArchiveRestoreIcon className="size-3.5" />
                  {t("Restore")}
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("Delete {title}", { title: bot.name })}
                  disabled={busy}
                  onClick={() => void handleDelete(bot)}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </>
            }
          />
        );
      })}
    </SettingsSection>
  );
}
