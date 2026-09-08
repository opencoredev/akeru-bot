import { useAtomValue } from "@effect/atom-react";
import {
  BotId,
  type ChannelConnectionId,
  type ChannelConnectionProfile,
  type ChannelProvider,
  type EnvironmentId,
  type OrchestrationBot,
} from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { resolveChannelSettingsAccess } from "../../channelAccess";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { botEnvironment, environmentBotsAtom } from "../../state/bots";
import { useEnvironmentSessionState } from "../../state/session";
import { useSettingsEnvironmentId } from "../../settingsDialogStore";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { ChannelSetupDialog } from "./ChannelSetupDialog";
import { CHANNEL_PROVIDER_META, channelProviderMeta } from "./channelProviderMeta";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const NO_ENVIRONMENT = "" as EnvironmentId;
const UNASSIGNED = "unassigned";

export function assignedBotForConnection(
  connectionId: ChannelConnectionId,
  bots: ReadonlyArray<Pick<OrchestrationBot, "id" | "name" | "archivedAt" | "channelBindings">>,
) {
  return bots.find((bot) =>
    (bot.channelBindings ?? []).some((binding) => binding.connectionId === connectionId),
  );
}

export function providerLabel(provider: ChannelProvider): string {
  if (provider === "imessage") return "Photon";
  if (provider === "whatsapp") return "Meta Cloud API";
  if (provider === "telegram") return "Telegram Bot API";
  if (provider === "slack") return "Slack Socket Mode";
  return "Discord Gateway";
}

export function channelTestInstructions(provider: ChannelProvider, botName?: string): string {
  if (provider === "imessage") return "Send a direct iMessage to this line to test a reply.";
  if (provider === "whatsapp") return "Send a direct WhatsApp message to this number.";
  if (provider === "telegram") return "Send a direct Telegram message to this bot.";
  if (provider === "slack") {
    return `Send a direct message or mention ${botName ?? "the bot"} in a Slack channel thread.`;
  }
  return `Send a direct message or mention ${botName ?? "the bot"} in a Discord server.`;
}

export function parsePhotonHostedCredentials(input: string): {
  readonly projectId: string;
  readonly projectSecret: string;
} | null {
  const entries = new Map<string, string>();
  for (const line of input.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) return null;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (
      (key !== "SPECTRUM_PROJECT_ID" && key !== "SPECTRUM_PROJECT_SECRET") ||
      !value ||
      entries.has(key)
    ) {
      return null;
    }
    entries.set(key, value);
  }
  const projectId = entries.get("SPECTRUM_PROJECT_ID");
  const projectSecret = entries.get("SPECTRUM_PROJECT_SECRET");
  return projectId && projectSecret ? { projectId, projectSecret } : null;
}

export function BotChannelsSettingsPanel() {
  const environmentId = useSettingsEnvironmentId();
  const targetEnvironmentId = environmentId ?? NO_ENVIRONMENT;
  const session = useEnvironmentSessionState(targetEnvironmentId);
  const bots = useAtomValue(environmentBotsAtom(targetEnvironmentId));
  const activeBots = useMemo(() => bots.filter((bot) => bot.archivedAt === null), [bots]);
  const connections = useEnvironmentSettings(
    targetEnvironmentId,
    (settings) => settings.channelConnections,
  );
  const deleteConnection = useAtomCommand(botEnvironment.channels.deleteConnection, {
    reportFailure: false,
  });
  const attach = useAtomCommand(botEnvironment.channels.attach, { reportFailure: false });
  const disconnect = useAtomCommand(botEnvironment.channels.disconnect, {
    reportFailure: false,
  });
  const detach = useAtomCommand(botEnvironment.channels.detach, { reportFailure: false });
  const reconnect = useAtomCommand(botEnvironment.channels.reconnect, {
    reportFailure: false,
  });
  const [provider, setProvider] = useState<ChannelProvider>("imessage");
  const [setupOpen, setSetupOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyConnectionId, setBusyConnectionId] = useState<string | null>(null);
  const [pendingProfile, setPendingProfile] = useState<{
    readonly id: string;
    readonly present: boolean;
  } | null>(null);
  const mutationRef = useRef(false);
  const access = resolveChannelSettingsAccess({
    isPending: session.isPending,
    session: session.data,
  });
  const providerConnections = connections.filter((connection) => connection.provider === provider);

  useEffect(() => {
    if (!pendingProfile) return;
    const present = connections.some((connection) => connection.id === pendingProfile.id);
    if (present !== pendingProfile.present) return;
    mutationRef.current = false;
    setBusy(false);
    setPendingProfile(null);
  }, [connections, pendingProfile]);

  const removeConnection = async (connection: ChannelConnectionProfile) => {
    if (!environmentId || mutationRef.current) return;
    mutationRef.current = true;
    setBusy(true);
    const result = await deleteConnection({
      environmentId,
      input: { connectionId: connection.id },
    });
    if (result._tag === "Failure") {
      mutationRef.current = false;
      setBusy(false);
      toastManager.add({ type: "error", title: "Unassign this channel before deleting it" });
      return;
    }
    setPendingProfile({ id: connection.id, present: false });
  };

  const updateAssignment = async (connection: ChannelConnectionProfile, nextBotId: string) => {
    if (!environmentId || busyConnectionId) return;
    const assignedBot = assignedBotForConnection(connection.id, bots);
    const assignedBinding = assignedBot?.channelBindings.find(
      (binding) => binding.connectionId === connection.id,
    );
    if (assignedBot?.id === nextBotId) return;
    setBusyConnectionId(connection.id);

    if (assignedBot) {
      const result = await detach({
        environmentId,
        input: { botId: assignedBot.id, provider: connection.provider },
      });
      if (result._tag === "Failure") {
        setBusyConnectionId(null);
        toastManager.add({ type: "error", title: "Could not unassign channel" });
        return;
      }
    }

    if (nextBotId !== UNASSIGNED) {
      const result = await attach({
        environmentId,
        input: {
          botId: BotId.make(nextBotId),
          connectionId: connection.id,
          provider: connection.provider,
        },
      });
      if (result._tag === "Failure") {
        const restored = assignedBot
          ? await attach({
              environmentId,
              input: {
                botId: assignedBot.id,
                connectionId: connection.id,
                ...(assignedBinding?.projectId ? { projectId: assignedBinding.projectId } : {}),
                provider: connection.provider,
              },
            })
          : null;
        toastManager.add({
          type: "error",
          title:
            restored?._tag === "Failure"
              ? "Could not assign or restore channel"
              : "Could not assign channel",
        });
      }
    }
    setBusyConnectionId(null);
  };

  if (environmentId === null) {
    return (
      <SettingsPageContainer>
        <div className="px-4 py-8 text-sm text-muted-foreground">Connect an environment first.</div>
      </SettingsPageContainer>
    );
  }
  if (access === "pending") {
    return (
      <SettingsPageContainer>
        <div className="flex justify-center px-4 py-8">
          <Spinner aria-label="Loading channel access" />
        </div>
      </SettingsPageContainer>
    );
  }
  if (access === "denied") {
    return (
      <SettingsPageContainer>
        <div className="px-4 py-8 text-sm text-muted-foreground">
          This client does not have permission to manage channels.
        </div>
      </SettingsPageContainer>
    );
  }

  const meta = channelProviderMeta(provider);

  return (
    <SettingsPageContainer className="gap-8">
      <SettingsSection {...searchableSetting("bot-channels")}>
        <div
          className="mx-3 flex flex-wrap gap-1 rounded-xl bg-muted/60 p-1 sm:mx-4"
          role="tablist"
          aria-label="Channel type"
        >
          {CHANNEL_PROVIDER_META.map((channel) => (
            <button
              key={channel.provider}
              type="button"
              role="tab"
              aria-selected={provider === channel.provider}
              onClick={() => setProvider(channel.provider)}
              className={cn(
                "flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors",
                provider === channel.provider
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <channel.icon className="size-4 shrink-0" aria-hidden />
              {channel.label}
            </button>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection
        title={meta.label}
        icon={<meta.icon className="size-5 shrink-0" aria-hidden />}
        headerAction={
          <Button onClick={() => setSetupOpen(true)}>
            <PlusIcon className="size-4" />
            Add connection
          </Button>
        }
      >
        <p className="mx-3 -mt-1 mb-1 text-sm text-muted-foreground sm:mx-4">{meta.tagline}.</p>
        {providerConnections.length === 0 ? (
          <div className="mx-3 flex flex-col items-start gap-3 rounded-xl border border-dashed px-4 py-6 sm:mx-4">
            <p className="text-sm text-muted-foreground">No {meta.label} connections yet.</p>
            <Button variant="outline" onClick={() => setSetupOpen(true)}>
              Set up {meta.label}
            </Button>
          </div>
        ) : (
          providerConnections.map((connection) => {
            const assignedBot = assignedBotForConnection(connection.id, bots);
            const binding = assignedBot?.channelBindings.find(
              (candidate) => candidate.connectionId === connection.id,
            );
            const externalIdentity = binding?.externalIdentity ?? connection.externalIdentity;
            const connectionBusy = busyConnectionId === connection.id;
            return (
              <div
                key={connection.id}
                className="mx-3 flex flex-col gap-3 rounded-xl border border-border/60 bg-muted/30 px-4 py-3.5 sm:mx-4"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
                  <meta.icon className="size-5 shrink-0" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-sm font-medium tracking-[-0.005em] text-foreground">
                      {connection.name}
                    </h3>
                    <p className="truncate text-[13px] text-muted-foreground/80">
                      {providerLabel(connection.provider)}
                      {externalIdentity ? ` · ${externalIdentity}` : ""}
                    </p>
                  </div>
                  <Badge
                    variant={
                      binding?.status === "failed" || binding?.status === "needs-reconnect"
                        ? "warning"
                        : binding?.status === "disconnected"
                          ? "secondary"
                          : assignedBot
                            ? "success"
                            : "secondary"
                    }
                    size="sm"
                  >
                    {binding?.status === "failed"
                      ? "Connection failed"
                      : binding?.status === "needs-reconnect"
                        ? "Needs reconnect"
                        : binding?.status === "disconnected"
                          ? `Disconnected · ${assignedBot?.name ?? "Assigned"}`
                          : assignedBot
                            ? `Assigned to ${assignedBot.name}`
                            : "Unassigned"}
                  </Badge>
                </div>
                {binding?.lastError ? (
                  <p
                    role="status"
                    className="break-words text-xs text-amber-600 dark:text-amber-400"
                  >
                    {binding.lastError}
                  </p>
                ) : null}
                {assignedBot ? (
                  <p className="text-[13px] text-muted-foreground/80">
                    {channelTestInstructions(connection.provider, assignedBot.name)}
                  </p>
                ) : null}
                <div className="flex min-w-0 flex-wrap items-end gap-x-4 gap-y-2">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-xs font-medium text-muted-foreground">
                      Bot that answers
                    </span>
                    <Select
                      value={assignedBot?.id ?? UNASSIGNED}
                      onValueChange={(next) => next && void updateAssignment(connection, next)}
                    >
                      <SelectTrigger
                        aria-label={`Assign ${connection.name}`}
                        className="w-48"
                        disabled={connectionBusy}
                      >
                        <SelectValue>{assignedBot?.name ?? "Choose a bot"}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        <SelectItem value={UNASSIGNED}>No bot</SelectItem>
                        {assignedBot?.archivedAt ? (
                          <SelectItem value={assignedBot.id}>
                            {assignedBot.name} (archived)
                          </SelectItem>
                        ) : null}
                        {activeBots.map((bot) => (
                          <SelectItem key={bot.id} value={bot.id}>
                            {bot.name}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </div>
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
                  {assignedBot && binding?.status === "connected" ? (
                    <Button
                      variant="outline"
                      disabled={busy || connectionBusy}
                      onClick={() => {
                        setBusyConnectionId(connection.id);
                        void disconnect({
                          environmentId,
                          input: { botId: assignedBot.id, provider: connection.provider },
                        }).then((result) => {
                          setBusyConnectionId(null);
                          if (result._tag === "Failure") {
                            toastManager.add({
                              type: "error",
                              title: "Could not disconnect channel",
                            });
                          }
                        });
                      }}
                    >
                      Disconnect
                    </Button>
                  ) : null}
                  {assignedBot &&
                  (binding?.status === "failed" ||
                    binding?.status === "needs-reconnect" ||
                    binding?.status === "disconnected") ? (
                    <Button
                      variant="outline"
                      disabled={busy || connectionBusy}
                      onClick={() => {
                        setBusyConnectionId(connection.id);
                        void reconnect({
                          environmentId,
                          input: { botId: assignedBot.id, provider: connection.provider },
                        }).then((result) => {
                          setBusyConnectionId(null);
                          if (result._tag === "Failure") {
                            toastManager.add({
                              type: "error",
                              title: "Could not reconnect channel",
                            });
                          }
                        });
                      }}
                    >
                      Reconnect
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    disabled={busy || connectionBusy || assignedBot !== undefined}
                    onClick={() => void removeConnection(connection)}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </SettingsSection>

      <ChannelSetupDialog
        environmentId={environmentId}
        provider={provider}
        open={setupOpen}
        onOpenChange={setSetupOpen}
        bots={activeBots}
        onSaved={(connectionId) => setPendingProfile({ id: connectionId, present: true })}
      />
    </SettingsPageContainer>
  );
}
