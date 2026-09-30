import { useAtomValue } from "@effect/atom-react";
import {
  channelBindingNeedsProject,
  channelFailureReason,
} from "@t3tools/client-runtime/channel-presentation";
import {
  createTranslator,
  type PluralForms,
  type TranslationParams,
} from "@t3tools/client-runtime/i18n";
import { defaultProjectIdForBot } from "@t3tools/shared/channelProject";
import {
  BotId,
  type ChannelConnectionId,
  type ChannelConnectionProfile,
  type ChannelProvider,
  type EnvironmentId,
  type OrchestrationBot,
  type ProjectId,
} from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  channelFailureCategoryOf,
  isChannelIdentityConflict,
  resolveChannelSettingsAccess,
} from "../../channelAccess";
import { requestConfirmDialog } from "../../confirmDialog";
import { useI18n } from "../../i18n";
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

type Translate = (message: string, params?: TranslationParams) => string;
type Pluralize = (count: number, forms: PluralForms) => string;

const englishTranslator = createTranslator("en");

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

export function channelTestInstructions(
  provider: ChannelProvider,
  botName?: string,
  t: Translate = englishTranslator.translate,
): string {
  if (provider === "imessage") return t("Send a direct iMessage to this line to test a reply.");
  if (provider === "whatsapp") return t("Send a direct WhatsApp message to this number.");
  if (provider === "telegram") return t("Send a direct Telegram message to this bot.");
  const name = botName ?? t("the bot");
  if (provider === "slack") {
    return t("Send a direct message or mention {name} in a Slack channel thread.", { name });
  }
  return t("Send a direct message or mention {name} in a Discord server.", { name });
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
type LiveProject = { readonly id: ProjectId };

/** The bot bound to a connection and its live binding, when there is one. */
export function connectionAssignment(
  connectionId: ChannelConnectionId,
  bots: ReadonlyArray<ChannelBot>,
) {
  const bot = assignedBotForConnection(connectionId, bots);
  const binding = bot?.channelBindings.find((candidate) => candidate.connectionId === connectionId);
  return { bot, binding };
}

/** Headline state of one connection, for list rows and the channel header. */
export function connectionState(
  bot: ChannelBot | undefined,
  binding: ChannelBinding | undefined,
  liveProjects: ReadonlyArray<LiveProject>,
  t: Translate = englishTranslator.translate,
): Pick<ProviderConnectionState, "tone" | "label"> {
  if (!bot || !binding) return { tone: "neutral", label: t("No bot") };
  if (channelBindingNeedsProject(binding, liveProjects)) {
    return { tone: "attention", label: t("Choose another project") };
  }
  switch (binding.status) {
    case "connecting":
      return { tone: "pending", label: t("Connecting…") };
    case "failed":
      return { tone: "attention", label: t("Connection failed") };
    case "needs-reconnect":
      return { tone: "attention", label: t("Needs reconnect") };
    case "disconnected":
      return { tone: "neutral", label: t("Disconnected") };
    case "not-live":
      return { tone: "attention", label: t("Not live") };
    default:
      return binding.lastError || binding.failureCategory
        ? { tone: "attention", label: t("Needs attention") }
        : { tone: "positive", label: t("Connected") };
  }
}

/** Headline state of a channel kind across all of its connections. */
export function channelState(
  provider: ChannelProvider,
  connections: ReadonlyArray<ChannelConnectionProfile>,
  bots: ReadonlyArray<ChannelBot>,
  liveProjects: ReadonlyArray<LiveProject>,
  t: Translate = englishTranslator.translate,
  plural: Pluralize = englishTranslator.plural,
): Pick<ProviderConnectionState, "tone" | "label"> {
  const own = connections.filter((connection) => connection.provider === provider);
  if (own.length === 0) return { tone: "neutral", label: t("Not set up") };
  const states = own.map((connection) => {
    const { bot, binding } = connectionAssignment(connection.id, bots);
    return connectionState(bot, binding, liveProjects, t);
  });
  if (states.some((state) => state.tone === "attention")) {
    return { tone: "attention", label: t("Needs attention") };
  }
  if (states.some((state) => state.tone === "pending")) {
    return { tone: "pending", label: t("Connecting…") };
  }
  return {
    tone: states.some((state) => state.tone === "positive") ? "positive" : "neutral",
    label: plural(own.length, { one: "{count} connection", other: "{count} connections" }),
  };
}

/** Everything the channel pages read and change, for one environment. */
export function useChannelSettings(environmentId: EnvironmentId | null) {
  const { t } = useI18n();
  const targetEnvironmentId = environmentId ?? NO_ENVIRONMENT;
  const session = useEnvironmentSessionState(targetEnvironmentId);
  const bots = useAtomValue(environmentBotsAtom(targetEnvironmentId));
  const snapshot = useAtomValue(environmentSnapshotAtom(targetEnvironmentId));
  const liveProjects = useMemo(() => snapshot?.projects ?? [], [snapshot]);
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
  const changeProject = useAtomCommand(botEnvironment.channels.changeProject, {
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

  // Toast detail for a failed channel command: the conflict or the category's reason, if known.
  const failureDescription = (
    result: Parameters<typeof channelFailureCategoryOf>[0],
    provider: ChannelProvider,
  ) => {
    if (isChannelIdentityConflict(result)) {
      return {
        description: t(
          "Another bot already uses this account. Unassign it there, then connect again.",
        ),
      };
    }
    const category = channelFailureCategoryOf(result);
    return category ? { description: channelFailureReason(category, provider, t) } : {};
  };

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
    const confirmed =
      (await requestConfirmDialog(
        t("Delete {name}? Its saved credentials are removed from this environment.", {
          name: connection.name,
        }),
        { variant: "destructive", confirmLabel: t("Delete") },
      )) ?? false;
    if (!confirmed || mutationRef.current) return;
    mutationRef.current = true;
    setBusy(true);
    const result = await deleteConnection({
      environmentId,
      input: { connectionId: connection.id },
    });
    if (result._tag === "Failure") {
      mutationRef.current = false;
      setBusy(false);
      toastManager.add({ type: "error", title: t("Unassign this channel before deleting it") });
      return;
    }
    setPendingProfile({ id: connection.id, present: false });
  };

  /** Moves a connection to another bot, or to no bot. A new bot needs a live project. */
  const updateAssignment = async (
    connection: ChannelConnectionProfile,
    nextBotId: string,
    projectId: ProjectId | null,
  ) => {
    if (!environmentId || busyConnectionId) return;
    if (nextBotId !== UNASSIGNED && projectId === null) return;
    const { bot: assignedBot, binding: assignedBinding } = connectionAssignment(
      connection.id,
      bots,
    );
    if (assignedBot?.id === nextBotId) return;
    const destinationBinding = bots
      .find((bot) => bot.id === nextBotId)
      ?.channelBindings.find((binding) => binding.provider === connection.provider);
    // A detached binding keeps its provider row without a connection, so only a bound or
    // still-live legacy binding occupies the bot.
    const destinationOccupied =
      destinationBinding !== undefined &&
      (destinationBinding.connectionId
        ? destinationBinding.connectionId !== connection.id
        : destinationBinding.status !== "disconnected");
    if (destinationOccupied) {
      toastManager.add({
        type: "error",
        title: t("Unassign the channel already connected to this bot first"),
      });
      return;
    }
    setBusyConnectionId(connection.id);

    if (assignedBot) {
      const result = await detach({
        environmentId,
        input: { botId: assignedBot.id, provider: connection.provider },
      });
      if (result._tag === "Failure") {
        setBusyConnectionId(null);
        toastManager.add({ type: "error", title: t("Could not unassign channel") });
        return;
      }
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
        // A failed attach keeps the new bot on the connection, so it has to let go before the
        // previous bot can have the connection back.
        // The previous project may be gone; restore into the chosen live project instead.
        const previousProjectId = assignedBinding?.projectId ?? null;
        const restoreProjectId =
          previousProjectId !== null &&
          liveProjects.some((project) => project.id === previousProjectId)
            ? previousProjectId
            : projectId;
        const released = assignedBot
          ? await detach({
              environmentId,
              input: { botId: BotId.make(nextBotId), provider: connection.provider },
            })
          : null;
        const restored = assignedBot
          ? await attach({
              environmentId,
              input: {
                botId: assignedBot.id,
                connectionId: connection.id,
                projectId: restoreProjectId,
                provider: connection.provider,
              },
            })
          : null;
        // Attaching starts the channel, so a binding the user had disconnected goes back to
        // disconnected rather than coming back online after a failed move.
        const stopped =
          assignedBot && restored?._tag === "Success" && assignedBinding?.status === "disconnected"
            ? await disconnect({
                environmentId,
                input: { botId: assignedBot.id, provider: connection.provider },
              })
            : null;
        toastManager.add({
          type: "error",
          title:
            released?._tag === "Failure" ||
            restored?._tag === "Failure" ||
            stopped?._tag === "Failure"
              ? t("Could not assign or restore channel")
              : t("Could not assign channel"),
          ...failureDescription(result, connection.provider),
        });
      }
    }
    setBusyConnectionId(null);
  };

  const moveToProject = async (
    connection: ChannelConnectionProfile,
    botId: BotId,
    projectId: ProjectId,
  ) => {
    if (!environmentId || busyConnectionId) return;
    setBusyConnectionId(connection.id);
    const result = await changeProject({
      environmentId,
      input: { botId, provider: connection.provider, projectId },
    });
    setBusyConnectionId(null);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: t("Could not move channel to this project"),
        ...failureDescription(result, connection.provider),
      });
    }
  };

  const runBindingCommand = async (
    command: typeof disconnect,
    connection: ChannelConnectionProfile,
    botId: BotId,
    failureTitle: string,
  ) => {
    if (!environmentId || busyConnectionId) return;
    setBusyConnectionId(connection.id);
    const result = await command({
      environmentId,
      input: { botId, provider: connection.provider },
    });
    setBusyConnectionId(null);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: failureTitle,
        ...failureDescription(result, connection.provider),
      });
    }
  };

  return {
    access,
    bots,
    activeBots,
    liveProjects,
    connections,
    busy,
    busyConnectionId,
    /** The project a picker preselects for a bot, or for any bot when `botId` is null. */
    projectHint: (botId: BotId | null) =>
      snapshot ? defaultProjectIdForBot(snapshot, botId) : null,
    removeConnection,
    updateAssignment,
    moveToProject,
    disconnectConnection: (connection: ChannelConnectionProfile, botId: BotId) =>
      runBindingCommand(disconnect, connection, botId, t("Could not disconnect channel")),
    reconnectConnection: (connection: ChannelConnectionProfile, botId: BotId) =>
      runBindingCommand(reconnect, connection, botId, t("Could not reconnect channel")),
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
  const { t } = useI18n();
  if (access === "no-environment") {
    return <SettingsMessageRow>{t("Connect an environment first.")}</SettingsMessageRow>;
  }
  if (access === "pending") {
    return (
      <SettingsMessageRow>
        <span className="inline-flex items-center gap-2">
          <Spinner aria-label={t("Loading channel access")} className="size-3.5" />
          {t("Checking access")}
        </span>
      </SettingsMessageRow>
    );
  }
  if (access === "denied") {
    return (
      <SettingsMessageRow>
        {t("This client does not have permission to manage channels.")}
      </SettingsMessageRow>
    );
  }
  return null;
}

/** The Channels overview: one row per channel kind, each opening its subpage. */
export function BotChannelsSettingsPanel() {
  const environmentId = useSettingsEnvironmentId();
  const { t, plural } = useI18n();
  const { access, bots, connections, liveProjects } = useChannelSettings(environmentId);
  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("bot-channels", t)}>
        {access === "allowed" ? (
          CHANNEL_PROVIDER_META.map((meta) => {
            const state = channelState(meta.provider, connections, bots, liveProjects, t, plural);
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
