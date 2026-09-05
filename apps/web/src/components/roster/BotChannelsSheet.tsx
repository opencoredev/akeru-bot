import { useAtomValue } from "@effect/atom-react";
import {
  BotId,
  type ChannelConnectionId,
  type ChannelConnectionProfile,
  type ChannelProvider,
  type EnvironmentId,
  type OrchestrationBot,
} from "@t3tools/contracts";
import { useState } from "react";

import { resolveChannelSettingsAccess } from "../../channelAccess";
import { usePrimarySettings } from "../../hooks/useSettings";
import { botEnvironment, environmentBotsAtom } from "../../state/bots";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentSessionState } from "../../state/session";
import { openSettings } from "../../settingsDialogStore";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Sheet, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "../ui/sheet";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import type { Bot } from "./types";

const NO_ENVIRONMENT = "" as EnvironmentId;

const providerLabel = (provider: ChannelProvider) =>
  provider === "imessage"
    ? "Photon"
    : provider === "whatsapp"
      ? "Meta Cloud API"
      : provider === "telegram"
        ? "Telegram Bot API"
        : provider === "slack"
          ? "Slack Socket Mode"
          : "Discord Gateway";

const assignedBotForConnection = (
  connectionId: ChannelConnectionId,
  bots: ReadonlyArray<Pick<OrchestrationBot, "id" | "name" | "channelBindings">>,
) =>
  bots.find((candidate) =>
    (candidate.channelBindings ?? []).some((binding) => binding.connectionId === connectionId),
  );

export function BotChannelsSheet({
  bot,
  open,
  onOpenChange,
}: {
  readonly bot: Bot;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const targetEnvironmentId = environmentId ?? NO_ENVIRONMENT;
  const session = useEnvironmentSessionState(targetEnvironmentId);
  const bots = useAtomValue(environmentBotsAtom(targetEnvironmentId));
  const connections = usePrimarySettings((settings) => settings.channelConnections);
  const attach = useAtomCommand(botEnvironment.channels.attach, { reportFailure: false });
  const disconnect = useAtomCommand(botEnvironment.channels.disconnect, {
    reportFailure: false,
  });
  const detach = useAtomCommand(botEnvironment.channels.detach, { reportFailure: false });
  const reconnect = useAtomCommand(botEnvironment.channels.reconnect, {
    reportFailure: false,
  });
  const [busyId, setBusyId] = useState<string | null>(null);
  const access = resolveChannelSettingsAccess({
    isPending: session.isPending,
    session: session.data,
  });

  const manage = async (connection: ChannelConnectionProfile) => {
    if (!environmentId) return;
    const owner = assignedBotForConnection(connection.id, bots);
    if (owner && owner.id !== bot.id) return;
    const binding = owner?.channelBindings?.find(
      (candidate) => candidate.connectionId === connection.id,
    );
    setBusyId(connection.id);
    const result =
      binding?.status === "needs-reconnect" ||
      binding?.status === "failed" ||
      binding?.status === "disconnected"
        ? await reconnect({
            environmentId,
            input: { botId: BotId.make(bot.id), provider: connection.provider },
          })
        : binding
          ? await disconnect({
              environmentId,
              input: { botId: BotId.make(bot.id), provider: connection.provider },
            })
          : await attach({
              environmentId,
              input: {
                botId: BotId.make(bot.id),
                connectionId: connection.id,
                provider: connection.provider,
              },
            });
    setBusyId(null);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not update channel" });
    }
  };

  const unassign = async (connection: ChannelConnectionProfile) => {
    if (!environmentId) return;
    setBusyId(connection.id);
    const result = await detach({
      environmentId,
      input: { botId: BotId.make(bot.id), provider: connection.provider },
    });
    setBusyId(null);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not unassign channel" });
    }
  };

  const openChannelSettings = () => {
    onOpenChange(false);
    openSettings("channels", null, environmentId);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup side="right" className="w-[min(94vw,28rem)]">
        <SheetHeader>
          <SheetTitle>{bot.name} channels</SheetTitle>
        </SheetHeader>
        <SheetPanel className="space-y-2 px-3">
          {environmentId === null ? (
            <div className="py-8 text-sm text-muted-foreground">Connect an environment first.</div>
          ) : access === "pending" ? (
            <div className="flex justify-center py-8">
              <Spinner aria-label="Loading channel access" />
            </div>
          ) : access === "denied" ? (
            <div className="py-8 text-sm text-muted-foreground">
              This client does not have permission to manage channels.
            </div>
          ) : connections.length === 0 ? (
            <div className="space-y-3 py-4">
              <p className="text-sm text-muted-foreground">Set up a channel connection first.</p>
              <Button onClick={openChannelSettings}>Set up channels</Button>
            </div>
          ) : (
            <>
              {connections.map((connection) => {
                const owner = assignedBotForConnection(connection.id, bots);
                const binding = owner?.channelBindings?.find(
                  (candidate) => candidate.connectionId === connection.id,
                );
                const ownedByCurrentBot = owner?.id === bot.id;
                const action =
                  owner && !ownedByCurrentBot
                    ? "Assigned"
                    : binding?.status === "needs-reconnect" ||
                        binding?.status === "failed" ||
                        binding?.status === "disconnected"
                      ? "Reconnect"
                      : binding
                        ? "Disconnect"
                        : "Connect";
                return (
                  <div
                    key={connection.id}
                    className="flex flex-col gap-3 rounded-xl border px-3 py-2.5"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="truncate text-sm font-medium">{connection.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {providerLabel(connection.provider)}
                        {(binding?.externalIdentity ?? connection.externalIdentity)
                          ? ` · ${binding?.externalIdentity ?? connection.externalIdentity}`
                          : ""}
                      </div>
                      {binding?.lastError ? (
                        <p
                          role="status"
                          className="break-words text-xs text-amber-600 dark:text-amber-400"
                        >
                          {binding.lastError}
                        </p>
                      ) : null}
                      {owner ? (
                        <Badge
                          variant={
                            binding?.status === "needs-reconnect" ||
                            binding?.status === "failed" ||
                            binding?.status === "disconnected"
                              ? "warning"
                              : "success"
                          }
                          size="sm"
                        >
                          {binding?.status === "failed"
                            ? "Connection failed"
                            : binding?.status === "needs-reconnect"
                              ? "Needs reconnect"
                              : binding?.status === "disconnected"
                                ? `Disconnected · ${owner.name}`
                                : `Assigned to ${owner.name}`}
                        </Badge>
                      ) : (
                        <Badge variant="secondary" size="sm">
                          Unassigned
                        </Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {connection.managementUrl ? (
                        <Button
                          variant="outline"
                          render={
                            <a href={connection.managementUrl} target="_blank" rel="noreferrer" />
                          }
                        >
                          Open provider
                        </Button>
                      ) : null}
                      {ownedByCurrentBot ? (
                        <Button
                          variant="outline"
                          disabled={busyId !== null}
                          onClick={() => void unassign(connection)}
                        >
                          Unassign
                        </Button>
                      ) : null}
                      <Button
                        variant={ownedByCurrentBot ? "outline" : "default"}
                        disabled={busyId !== null || (owner !== undefined && !ownedByCurrentBot)}
                        onClick={() => void manage(connection)}
                      >
                        {action}
                      </Button>
                    </div>
                  </div>
                );
              })}
              <Button variant="outline" onClick={openChannelSettings}>
                Manage connections
              </Button>
            </>
          )}
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}
