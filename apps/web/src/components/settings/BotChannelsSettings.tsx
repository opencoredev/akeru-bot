import { useAtomValue } from "@effect/atom-react";
import { defaultProjectIdForBot } from "@t3tools/shared/channelProject";
import {
  BotId,
  type ChannelConnectionId,
  type ChannelConnectionProfile,
  type ChannelProvider,
  type EnvironmentId,
  type OrchestrationBot,
} from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { resolveChannelSettingsAccess } from "../../channelAccess";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { botEnvironment, environmentBotsAtom } from "../../state/bots";
import { useEnvironmentSessionState } from "../../state/session";
import { environmentSnapshotAtom } from "../../state/shell";
import { useSettingsEnvironmentId } from "../../settingsDialogStore";
import { useAtomCommand } from "../../state/use-atom-command";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { CHANNEL_PROVIDER_META } from "./channelProviderMeta";
import type { ProviderConnectionState } from "./providerStatus";
import { SettingsLinkRow, SettingsMessageRow } from "./settingsDetailLayout";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const NO_ENVIRONMENT = "" as EnvironmentId;
export const UNASSIGNED = "unassigned";

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

type ChannelBot = Pick<OrchestrationBot, "id" | "name" | "archivedAt" | "channelBindings">;
type ChannelBinding = OrchestrationBot["channelBindings"][number];

/** The bot bound to a connection and its live binding, when there is one. */
export function connectionAssignment(
  connectionId: ChannelConnectionId,
  bots: ReadonlyArray<ChannelBot>,
) {
  const bot = assignedBotForConnection(connectionId, bots);
  const binding = bot?.channelBindings.find((candidate) => candidate.connectionId === connectionId);
  return { bot, binding };
}

export function bindingNeedsReconnect(binding: ChannelBinding | undefined): boolean {
  return (
    binding?.status === "failed" ||
    binding?.status === "needs-reconnect" ||
    binding?.status === "disconnected"
  );
}

/** Headline state of one connection. */
export function connectionState(
  bot: ChannelBot | undefined,
  binding: ChannelBinding | undefined,
): Pick<ProviderConnectionState, "tone" | "label"> {
  if (!bot) return { tone: "neutral", label: "No bot" };
  if (binding?.status === "failed") return { tone: "attention", label: "Connection failed" };
  if (binding?.status === "needs-reconnect") return { tone: "attention", label: "Needs reconnect" };
  if (binding?.status === "disconnected") return { tone: "neutral", label: "Disconnected" };
  if (binding?.status === "not-live") return { tone: "pending", label: "Not live" };
  return { tone: "positive", label: "Connected" };
}

/** Headline state of a channel kind across all of its connections. */
export function channelState(
  provider: ChannelProvider,
  connections: ReadonlyArray<ChannelConnectionProfile>,
  bots: ReadonlyArray<ChannelBot>,
): Pick<ProviderConnectionState, "tone" | "label"> {
  const own = connections.filter((connection) => connection.provider === provider);
  if (own.length === 0) return { tone: "neutral", label: "Not set up" };
  const states = own.map((connection) => {
    const { bot, binding } = connectionAssignment(connection.id, bots);
    return connectionState(bot, binding);
  });
  if (states.some((state) => state.tone === "attention")) {
    return { tone: "attention", label: "Needs attention" };
  }
  return {
    tone: states.some((state) => state.tone === "positive") ? "positive" : "neutral",
    label: own.length === 1 ? "1 connection" : `${own.length} connections`,
  };
}

/** Everything the channel pages read and change, for one environment. */
export function useChannelSettings(environmentId: EnvironmentId | null) {
  const targetEnvironmentId = environmentId ?? NO_ENVIRONMENT;
  const session = useEnvironmentSessionState(targetEnvironmentId);
  const bots = useAtomValue(environmentBotsAtom(targetEnvironmentId));
  const snapshot = useAtomValue(environmentSnapshotAtom(targetEnvironmentId));
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
  const [busy, setBusy] = useState(false);
  const [busyConnectionId, setBusyConnectionId] = useState<string | null>(null);
  const [pendingProfile, setPendingProfile] = useState<{
    readonly id: string;
    readonly present: boolean;
  } | null>(null);
  const mutationRef = useRef(false);
  const access =
    environmentId === null
      ? "no-environment"
      : resolveChannelSettingsAccess({ isPending: session.isPending, session: session.data });

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
    const { bot: assignedBot, binding: assignedBinding } = connectionAssignment(
      connection.id,
      bots,
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

    // Channel bindings name an explicit project. Settings has no picker yet, so it uses the
    // project the bot works in most recently, or another live one.
    const projectId =
      nextBotId === UNASSIGNED || !snapshot
        ? null
        : defaultProjectIdForBot(snapshot, BotId.make(nextBotId));
    if (nextBotId !== UNASSIGNED && projectId === null) {
      setBusyConnectionId(null);
      toastManager.add({
        type: "error",
        title: "Could not assign channel",
        description: "Add a project before you connect a channel.",
      });
      return;
    }
    if (nextBotId !== UNASSIGNED && projectId !== null) {
      const result = await attach({
        environmentId,
        input: {
          botId: BotId.make(nextBotId),
          connectionId: connection.id,
          provider: connection.provider,
          projectId,
        },
      });
      if (result._tag === "Failure") {
        const restored = assignedBot
          ? await attach({
              environmentId,
              input: {
                botId: assignedBot.id,
                connectionId: connection.id,
                projectId: assignedBinding?.projectId ?? projectId,
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

  const runBindingCommand = async (
    command: typeof disconnect,
    connection: ChannelConnectionProfile,
    botId: BotId,
    failureTitle: string,
  ) => {
    if (!environmentId) return;
    setBusyConnectionId(connection.id);
    const result = await command({
      environmentId,
      input: { botId, provider: connection.provider },
    });
    setBusyConnectionId(null);
    if (result._tag === "Failure") toastManager.add({ type: "error", title: failureTitle });
  };

  return {
    access,
    bots,
    activeBots,
    connections,
    busy,
    busyConnectionId,
    removeConnection,
    updateAssignment,
    disconnectConnection: (connection: ChannelConnectionProfile, botId: BotId) =>
      runBindingCommand(disconnect, connection, botId, "Could not disconnect channel"),
    reconnectConnection: (connection: ChannelConnectionProfile, botId: BotId) =>
      runBindingCommand(reconnect, connection, botId, "Could not reconnect channel"),
    /** Hold the page busy until a connection the setup dialog saved shows up. */
    awaitSavedConnection: (connectionId: string) =>
      setPendingProfile({ id: connectionId, present: true }),
  };
}

/** Why the channel pages cannot show connections yet, or null when they can. */
export function ChannelAccessRow({
  access,
}: {
  readonly access: ReturnType<typeof useChannelSettings>["access"];
}) {
  if (access === "no-environment") {
    return <SettingsMessageRow>Connect an environment first.</SettingsMessageRow>;
  }
  if (access === "pending") {
    return (
      <SettingsMessageRow>
        <span className="inline-flex items-center gap-2">
          <Spinner aria-label="Loading channel access" className="size-3.5" />
          Checking access
        </span>
      </SettingsMessageRow>
    );
  }
  if (access === "denied") {
    return (
      <SettingsMessageRow>
        This client does not have permission to manage channels.
      </SettingsMessageRow>
    );
  }
  return null;
}

/** The Channels overview: one row per channel kind, each opening its subpage. */
export function BotChannelsSettingsPanel() {
  const environmentId = useSettingsEnvironmentId();
  const { access, bots, connections } = useChannelSettings(environmentId);
  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("bot-channels")}>
        {access === "allowed" ? (
          CHANNEL_PROVIDER_META.map((meta) => {
            const state = channelState(meta.provider, connections, bots);
            return (
              <SettingsLinkRow
                key={meta.provider}
                link={{ to: "/settings/channels/$channel", params: { channel: meta.provider } }}
                icon={meta.icon}
                title={meta.label}
                description={meta.tagline}
                tone={state.tone}
                statusLabel={state.label}
              />
            );
          })
        ) : (
          <ChannelAccessRow access={access} />
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
