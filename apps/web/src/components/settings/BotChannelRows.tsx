import {
  type ChannelBinding,
  type ChannelProvider,
  type EnvironmentId,
  type OrchestrationBot,
} from "@t3tools/contracts";
import { useState } from "react";

import { botEnvironment } from "../../state/bots";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";

export function bindingFor(
  bot: Pick<OrchestrationBot, "id" | "channelBindings">,
  provider: ChannelProvider,
): ChannelBinding {
  return (
    bot.channelBindings?.find((binding) => binding.provider === provider) ?? {
      botId: bot.id,
      provider,
      status: provider === "whatsapp" ? "not-live" : "disconnected",
      externalIdentity: null,
      connectedAt: null,
      sentMessageIds: [],
    }
  );
}

export function selfHostedIMessageConnectInput(
  botId: OrchestrationBot["id"],
  serverUrl: string,
  apiKey: string,
  phone: string,
) {
  const trimmedPhone = phone.trim();
  return {
    botId,
    provider: "imessage" as const,
    mode: "self-hosted" as const,
    serverUrl: serverUrl.trim(),
    apiKey: apiKey.trim(),
    ...(trimmedPhone ? { phone: trimmedPhone } : {}),
  };
}

function statusLabel(status: ChannelBinding["status"]): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "needs-reconnect":
      return "Needs reconnect";
    case "not-live":
      return "Not live";
    case "disconnected":
      return "Disconnected";
  }
}

function description(binding: ChannelBinding): string {
  return `${statusLabel(binding.status)}${binding.externalIdentity ? ` · ${binding.externalIdentity}` : ""}`;
}

function useChannelActions(
  environmentId: EnvironmentId,
  bot: OrchestrationBot,
  provider: "telegram" | "imessage",
  label: string,
) {
  const binding = bindingFor(bot, provider);
  const disconnect = useAtomCommand(botEnvironment.channels.disconnect, { reportFailure: false });
  const reconnect = useAtomCommand(botEnvironment.channels.reconnect, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<{ readonly _tag: string }>, failure: string) => {
    setBusy(true);
    const result = await action();
    setBusy(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: failure });
      return false;
    }
    return true;
  };
  const connected = binding.status === "connected" || binding.status === "needs-reconnect";
  const connectedControl = (
    <div className="flex items-center gap-2">
      <Button
        disabled={busy}
        variant="outline"
        onClick={() =>
          void run(
            () => reconnect({ environmentId, input: { botId: bot.id, provider } }),
            `Could not reconnect ${label}`,
          )
        }
      >
        Reconnect
      </Button>
      <Button
        disabled={busy}
        variant="outline"
        onClick={() =>
          void run(
            () => disconnect({ environmentId, input: { botId: bot.id, provider } }),
            `Could not disconnect ${label}`,
          )
        }
      >
        Disconnect
      </Button>
    </div>
  );
  return { binding, busy, connected, connectedControl, run };
}

export function TelegramChannelRow({
  environmentId,
  bot,
}: {
  readonly environmentId: EnvironmentId;
  readonly bot: OrchestrationBot;
}) {
  const connect = useAtomCommand(botEnvironment.channels.connect, { reportFailure: false });
  const [token, setToken] = useState("");
  const actions = useChannelActions(environmentId, bot, "telegram", "Telegram");
  return (
    <SettingsRow
      title="Telegram"
      description={description(actions.binding)}
      control={
        actions.connected ? (
          actions.connectedControl
        ) : (
          <div className="flex w-72 gap-2">
            <Input
              aria-label="Telegram BotFather token"
              placeholder="BotFather token"
              type="password"
              value={token}
              onChange={(event) => setToken(event.currentTarget.value)}
            />
            <Button
              disabled={actions.busy || token.trim().length === 0}
              onClick={() =>
                void actions
                  .run(
                    () =>
                      connect({
                        environmentId,
                        input: { botId: bot.id, provider: "telegram", token: token.trim() },
                      }),
                    "Could not connect Telegram",
                  )
                  .then((success) => success && setToken(""))
              }
            >
              Connect
            </Button>
          </div>
        )
      }
    />
  );
}

export function IMessageChannelRow({
  environmentId,
  bot,
}: {
  readonly environmentId: EnvironmentId;
  readonly bot: OrchestrationBot;
}) {
  const connect = useAtomCommand(botEnvironment.channels.connect, { reportFailure: false });
  const [mode, setMode] = useState<"hosted" | "self-hosted">("hosted");
  const [projectId, setProjectId] = useState("");
  const [projectSecret, setProjectSecret] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [phone, setPhone] = useState("");
  const actions = useChannelActions(environmentId, bot, "imessage", "iMessage");
  const missingCredentials =
    mode === "hosted"
      ? !projectId.trim() || !projectSecret.trim()
      : !serverUrl.trim() || !apiKey.trim();
  return (
    <SettingsRow
      title="iMessage"
      description={description(actions.binding)}
      control={
        actions.connected ? (
          actions.connectedControl
        ) : (
          <div className="flex w-72 flex-col gap-2">
            <Select value={mode} onValueChange={(value) => value && setMode(value)}>
              <SelectTrigger aria-label="iMessage connection type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="hosted">Photon hosted or free/shared number</SelectItem>
                <SelectItem value="self-hosted">Photon self-hosted</SelectItem>
              </SelectPopup>
            </Select>
            {mode === "hosted" ? (
              <>
                <Input
                  aria-label="Photon project ID"
                  placeholder="Photon project ID"
                  value={projectId}
                  onChange={(event) => setProjectId(event.currentTarget.value)}
                />
                <Input
                  aria-label="Photon project secret"
                  placeholder="Photon project secret"
                  type="password"
                  value={projectSecret}
                  onChange={(event) => setProjectSecret(event.currentTarget.value)}
                />
              </>
            ) : (
              <>
                <Input
                  aria-label="Photon server"
                  placeholder="Photon gRPC host:port"
                  value={serverUrl}
                  onChange={(event) => setServerUrl(event.currentTarget.value)}
                />
                <Input
                  aria-label="Photon API key"
                  placeholder="Photon API key"
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.currentTarget.value)}
                />
                <Input
                  aria-label="Photon phone or line"
                  placeholder="Phone or line (optional)"
                  value={phone}
                  onChange={(event) => setPhone(event.currentTarget.value)}
                />
              </>
            )}
            <div className="flex justify-between gap-2">
              <Button
                variant="outline"
                onClick={() => window.open("https://photon.codes/pricing", "_blank", "noopener")}
              >
                Free/shared number
              </Button>
              <Button
                disabled={actions.busy || missingCredentials}
                onClick={() =>
                  void actions.run(
                    () =>
                      connect({
                        environmentId,
                        input:
                          mode === "hosted"
                            ? {
                                botId: bot.id,
                                provider: "imessage",
                                mode,
                                projectId: projectId.trim(),
                                projectSecret: projectSecret.trim(),
                              }
                            : selfHostedIMessageConnectInput(bot.id, serverUrl, apiKey, phone),
                      }),
                    "Could not connect iMessage",
                  )
                }
              >
                Connect
              </Button>
            </div>
          </div>
        )
      }
    />
  );
}

export function WhatsAppChannelRow({ bot }: { readonly bot: OrchestrationBot }) {
  return (
    <SettingsRow
      title="WhatsApp"
      description={description(bindingFor(bot, "whatsapp"))}
      control={<span className="text-sm text-muted-foreground">Not available</span>}
    />
  );
}
