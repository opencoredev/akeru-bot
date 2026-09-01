import { useAtomValue } from "@effect/atom-react";
import {
  BotId,
  ChannelConnectionId,
  type ChannelConnectionProfile,
  type ChannelProvider,
  type EnvironmentId,
  type OrchestrationBot,
} from "@t3tools/contracts";
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
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const NO_ENVIRONMENT = "" as EnvironmentId;
const UNASSIGNED = "unassigned";

const CHANNELS: ReadonlyArray<{
  readonly provider: ChannelProvider;
  readonly label: string;
}> = [
  { provider: "imessage", label: "iMessage" },
  { provider: "whatsapp", label: "WhatsApp" },
  { provider: "telegram", label: "Telegram" },
];

export function assignedBotForConnection(
  connectionId: ChannelConnectionId,
  bots: ReadonlyArray<Pick<OrchestrationBot, "id" | "name" | "archivedAt" | "channelBindings">>,
) {
  return bots.find((bot) =>
    (bot.channelBindings ?? []).some(
      (binding) => binding.connectionId === connectionId && binding.status !== "disconnected",
    ),
  );
}

export function providerLabel(provider: ChannelProvider): string {
  return provider === "imessage"
    ? "Photon"
    : provider === "whatsapp"
      ? "Meta Cloud API"
      : "Telegram Bot API";
}

export function channelTestInstructions(provider: ChannelProvider, botName?: string): string {
  return provider === "imessage"
    ? `Text the number shown in Photon. ${botName ?? "The bot"} replies automatically. Groups need a dedicated line and an exact @${botName ?? "BotName"} mention.`
    : provider === "whatsapp"
      ? "Send a WhatsApp message to this number to test a reply."
      : "Send a Telegram message to this bot to test a reply.";
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
  const saveConnection = useAtomCommand(botEnvironment.channels.saveConnection, {
    reportFailure: false,
  });
  const deleteConnection = useAtomCommand(botEnvironment.channels.deleteConnection, {
    reportFailure: false,
  });
  const attach = useAtomCommand(botEnvironment.channels.attach, { reportFailure: false });
  const disconnect = useAtomCommand(botEnvironment.channels.disconnect, {
    reportFailure: false,
  });
  const [provider, setProvider] = useState<ChannelProvider>("imessage");
  const [mode, setMode] = useState<"hosted" | "self-hosted">("hosted");
  const [name, setName] = useState("");
  const [photonCredentials, setPhotonCredentials] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
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
  const value = (key: string) => values[key] ?? "";
  const setValue = (key: string, next: string) =>
    setValues((current) => ({ ...current, [key]: next }));
  const providerConnections = connections.filter((connection) => connection.provider === provider);
  const required =
    provider === "telegram"
      ? [value("token")]
      : provider === "whatsapp"
        ? [value("accessToken"), value("appSecret"), value("phoneNumberId"), value("verifyToken")]
        : mode === "hosted"
          ? [value("projectId"), value("projectSecret")]
          : [value("serverUrl"), value("apiKey")];

  useEffect(() => {
    setName("");
    setPhotonCredentials("");
    setValues({});
  }, [provider]);

  useEffect(() => {
    if (!pendingProfile) return;
    const present = connections.some((connection) => connection.id === pendingProfile.id);
    if (present !== pendingProfile.present) return;
    mutationRef.current = false;
    setBusy(false);
    setPendingProfile(null);
  }, [connections, pendingProfile]);

  const addConnection = async () => {
    if (!environmentId || mutationRef.current) return;
    mutationRef.current = true;
    setBusy(true);
    const random = crypto.getRandomValues(new Uint32Array(4));
    const connectionId = ChannelConnectionId.make(`channel-${[...random].join("-")}`);
    const input =
      provider === "telegram"
        ? { connectionId, name: name.trim(), provider, token: value("token").trim() }
        : provider === "whatsapp"
          ? {
              connectionId,
              name: name.trim(),
              provider,
              accessToken: value("accessToken").trim(),
              appSecret: value("appSecret").trim(),
              phoneNumberId: value("phoneNumberId").trim(),
              verifyToken: value("verifyToken").trim(),
            }
          : mode === "hosted"
            ? {
                connectionId,
                name: name.trim(),
                provider,
                mode,
                projectId: value("projectId").trim(),
                projectSecret: value("projectSecret").trim(),
              }
            : {
                connectionId,
                name: name.trim(),
                provider,
                mode,
                serverUrl: value("serverUrl").trim(),
                apiKey: value("apiKey").trim(),
                ...(value("phone").trim() ? { phone: value("phone").trim() } : {}),
              };
    const result = await saveConnection({ environmentId, input });
    if (result._tag === "Failure") {
      mutationRef.current = false;
      setBusy(false);
      toastManager.add({ type: "error", title: "Could not save channel" });
      return;
    }
    setPendingProfile({ id: connectionId, present: true });
    setName("");
    setPhotonCredentials("");
    setValues({});
  };

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
    if (assignedBot?.id === nextBotId) return;
    setBusyConnectionId(connection.id);

    if (assignedBot) {
      const result = await disconnect({
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
          Open this environment on its host to manage channels.
        </div>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer className="gap-8">
      <SettingsSection {...searchableSetting("bot-channels")}>
        <div
          className="mx-3 grid grid-cols-3 gap-1 rounded-xl bg-muted/60 p-1 sm:mx-4"
          role="tablist"
          aria-label="Channel type"
        >
          {CHANNELS.map((channel) => (
            <button
              key={channel.provider}
              type="button"
              role="tab"
              aria-selected={provider === channel.provider}
              onClick={() => setProvider(channel.provider)}
              className={cn(
                "h-8 rounded-lg px-3 text-sm font-medium transition-colors",
                provider === channel.provider
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {channel.label}
            </button>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection
        title={CHANNELS.find((channel) => channel.provider === provider)?.label ?? "Channels"}
      >
        {providerConnections.length === 0 ? (
          <div className="mx-3 rounded-xl border border-dashed px-4 py-6 text-sm text-muted-foreground sm:mx-4">
            No connections.
          </div>
        ) : (
          providerConnections.map((connection) => {
            const assignedBot = assignedBotForConnection(connection.id, bots);
            const connectionBusy = busyConnectionId === connection.id;
            return (
              <SettingsRow
                key={connection.id}
                title={connection.name}
                description={`${providerLabel(connection.provider)}${connection.externalIdentity ? ` · ${connection.externalIdentity}` : ""}${assignedBot ? ` · ${channelTestInstructions(connection.provider, assignedBot.name)}` : ""}`}
                status={
                  <Badge variant={assignedBot ? "success" : "secondary"} size="sm">
                    {assignedBot ? `Assigned to ${assignedBot.name}` : "Unassigned"}
                  </Badge>
                }
                control={
                  <div className="flex items-center gap-2">
                    {connection.managementUrl ? (
                      <Button
                        variant="outline"
                        render={
                          <a href={connection.managementUrl} target="_blank" rel="noreferrer" />
                        }
                      >
                        Open Photon
                      </Button>
                    ) : null}
                    <Select
                      value={assignedBot?.id ?? UNASSIGNED}
                      onValueChange={(next) => next && void updateAssignment(connection, next)}
                    >
                      <SelectTrigger
                        aria-label={`Assign ${connection.name}`}
                        className="w-40"
                        disabled={connectionBusy}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
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
                    <Button
                      variant="outline"
                      disabled={busy || connectionBusy || assignedBot !== undefined}
                      onClick={() => void removeConnection(connection)}
                    >
                      Delete
                    </Button>
                  </div>
                }
              />
            );
          })
        )}
      </SettingsSection>

      <SettingsSection title="Add connection">
        <SettingsRow
          title={provider === "imessage" ? "Photon" : providerLabel(provider)}
          control={
            <div className="flex w-72 flex-col gap-2">
              <Input
                aria-label="Name"
                placeholder={provider === "imessage" ? "Name, e.g. Work iPhone" : "Name"}
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
              />
              {provider === "telegram" ? (
                <Input
                  type="password"
                  placeholder="BotFather token"
                  aria-label="Telegram BotFather token"
                  value={value("token")}
                  onChange={(event) => setValue("token", event.currentTarget.value)}
                />
              ) : null}
              {provider === "imessage" ? (
                <>
                  <Select value={mode} onValueChange={(next) => next && setMode(next)}>
                    <SelectTrigger aria-label="Photon connection type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="hosted">Photon hosted</SelectItem>
                      <SelectItem value="self-hosted">Photon self-hosted</SelectItem>
                    </SelectPopup>
                  </Select>
                  {mode === "hosted" ? (
                    <Textarea
                      aria-label="Photon hosted credentials"
                      className="min-h-20 font-mono text-xs"
                      placeholder={"SPECTRUM_PROJECT_ID=...\nSPECTRUM_PROJECT_SECRET=..."}
                      rows={2}
                      spellCheck={false}
                      value={photonCredentials}
                      onChange={(event) => {
                        const next = event.currentTarget.value;
                        const parsed = parsePhotonHostedCredentials(next);
                        setPhotonCredentials(next);
                        setValues((current) => ({
                          ...current,
                          projectId: parsed?.projectId ?? "",
                          projectSecret: parsed?.projectSecret ?? "",
                        }));
                      }}
                    />
                  ) : (
                    <>
                      <Input
                        aria-label="Photon server"
                        placeholder="Photon server"
                        value={value("serverUrl")}
                        onChange={(event) => setValue("serverUrl", event.currentTarget.value)}
                      />
                      <Input
                        aria-label="Photon API key"
                        type="password"
                        placeholder="Photon API key"
                        value={value("apiKey")}
                        onChange={(event) => setValue("apiKey", event.currentTarget.value)}
                      />
                      <Input
                        aria-label="Photon phone or line"
                        placeholder="Phone or line"
                        value={value("phone")}
                        onChange={(event) => setValue("phone", event.currentTarget.value)}
                      />
                    </>
                  )}
                </>
              ) : null}
              {provider === "whatsapp" ? (
                <>
                  <Input
                    aria-label="WhatsApp access token"
                    type="password"
                    placeholder="Access token"
                    value={value("accessToken")}
                    onChange={(event) => setValue("accessToken", event.currentTarget.value)}
                  />
                  <Input
                    aria-label="WhatsApp app secret"
                    type="password"
                    placeholder="App secret"
                    value={value("appSecret")}
                    onChange={(event) => setValue("appSecret", event.currentTarget.value)}
                  />
                  <Input
                    aria-label="WhatsApp phone number ID"
                    placeholder="Phone number ID"
                    value={value("phoneNumberId")}
                    onChange={(event) => setValue("phoneNumberId", event.currentTarget.value)}
                  />
                  <Input
                    aria-label="WhatsApp verify token"
                    type="password"
                    placeholder="Verify token"
                    value={value("verifyToken")}
                    onChange={(event) => setValue("verifyToken", event.currentTarget.value)}
                  />
                </>
              ) : null}
              <Button
                disabled={busy || !name.trim() || required.some((item) => !item.trim())}
                onClick={() => void addConnection()}
              >
                Add connection
              </Button>
            </div>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
