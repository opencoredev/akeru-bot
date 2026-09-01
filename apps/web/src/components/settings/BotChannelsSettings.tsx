import { useAtomValue } from "@effect/atom-react";
import { GROUP_SHARED_WORKSPACE_WARNING, type EnvironmentId } from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { resolveChannelSettingsAccess } from "../../channelAccess";
import { environmentBotsAtom } from "../../state/bots";
import { useEnvironmentSessionState } from "../../state/session";
import { useSettingsEnvironmentId } from "../../settingsDialogStore";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { IMessageChannelRow, TelegramChannelRow, WhatsAppChannelRow } from "./BotChannelRows";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const NO_ENVIRONMENT = "" as EnvironmentId;

export function BotChannelsSettingsPanel() {
  const environmentId = useSettingsEnvironmentId();
  const bots = useAtomValue(environmentBotsAtom(environmentId ?? NO_ENVIRONMENT));
  const session = useEnvironmentSessionState(environmentId ?? NO_ENVIRONMENT);
  const activeBots = useMemo(() => bots.filter((bot) => bot.archivedAt === null), [bots]);
  const [selectedBotId, setSelectedBotId] = useState("");
  const bot =
    activeBots.find((candidate) => candidate.id === selectedBotId) ?? activeBots[0] ?? null;
  const access = resolveChannelSettingsAccess({
    isPending: session.isPending,
    session: session.data,
  });

  return (
    <SettingsPageContainer>
      {environmentId === null || bot === null ? (
        <div className="px-4 py-8 text-sm text-muted-foreground">
          {environmentId === null ? "Connect an environment first." : "Create a bot first."}
        </div>
      ) : access === "pending" ? (
        <div className="flex justify-center px-4 py-8 text-muted-foreground">
          <Spinner aria-label="Loading channel access" />
        </div>
      ) : access === "denied" ? (
        <div className="px-4 py-8 text-sm text-muted-foreground">
          Open this environment on its host to manage channels.
        </div>
      ) : (
        <SettingsSection {...searchableSetting("bot-channels")}>
          <div className="mx-3 mb-3 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2 text-xs leading-5 text-muted-foreground sm:mx-4">
            {GROUP_SHARED_WORKSPACE_WARNING}
          </div>
          <SettingsRow
            title="Bot"
            control={
              <Select value={bot.id} onValueChange={(value) => value && setSelectedBotId(value)}>
                <SelectTrigger aria-label="Bot" className="w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {activeBots.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <TelegramChannelRow environmentId={environmentId} bot={bot} />
          <IMessageChannelRow environmentId={environmentId} bot={bot} />
          <WhatsAppChannelRow environmentId={environmentId} bot={bot} />
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}
