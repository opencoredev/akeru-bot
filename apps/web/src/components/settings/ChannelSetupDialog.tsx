import {
  BotId,
  ChannelConnectionId,
  type ChannelProvider,
  type EnvironmentId,
} from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { botEnvironment } from "../../state/bots";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { parsePhotonHostedCredentials } from "./BotChannelsSettings";
import { channelProviderMeta, discordInviteUrl, slackPasteTarget } from "./channelProviderMeta";

const STEPS = ["Set up", "Credentials", "Connect"] as const;
const CONNECT_LATER = "connect-later";

export function buildChannelConnectionSaveInput(input: {
  readonly connectionId: ChannelConnectionId;
  readonly name: string;
  readonly provider: ChannelProvider;
  readonly mode: "hosted" | "self-hosted";
  readonly values: Record<string, string>;
}) {
  const { connectionId, name, provider, mode, values } = input;
  const value = (key: string) => (values[key] ?? "").trim();
  if (provider === "telegram") return { connectionId, name, provider, token: value("token") };
  if (provider === "whatsapp") {
    return {
      connectionId,
      name,
      provider,
      accessToken: value("accessToken"),
      appSecret: value("appSecret"),
      phoneNumberId: value("phoneNumberId"),
      verifyToken: value("verifyToken"),
    };
  }
  if (provider === "slack") {
    return {
      connectionId,
      name,
      provider,
      botToken: value("botToken"),
      appToken: value("appToken"),
    };
  }
  if (provider === "discord") {
    return {
      connectionId,
      name,
      provider,
      applicationId: value("applicationId"),
      publicKey: value("publicKey"),
      botToken: value("botToken"),
    };
  }
  return mode === "hosted"
    ? {
        connectionId,
        name,
        provider,
        mode,
        projectId: value("projectId"),
        projectSecret: value("projectSecret"),
      }
    : {
        connectionId,
        name,
        provider,
        mode,
        serverUrl: value("serverUrl"),
        apiKey: value("apiKey"),
        ...(value("phone") ? { phone: value("phone") } : {}),
      };
}

export function ChannelSetupDialog({
  environmentId,
  provider,
  bots,
  open,
  onOpenChange,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly provider: ChannelProvider;
  readonly bots: ReadonlyArray<{ readonly id: BotId; readonly name: string }>;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSaved: (connectionId: ChannelConnectionId) => void;
}) {
  const meta = channelProviderMeta(provider);
  const saveConnection = useAtomCommand(botEnvironment.channels.saveConnection, {
    reportFailure: false,
  });
  const attach = useAtomCommand(botEnvironment.channels.attach, { reportFailure: false });
  const [botId, setBotId] = useState<string>(() => bots[0]?.id ?? CONNECT_LATER);
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<"hosted" | "self-hosted">("hosted");
  const [name, setName] = useState("");
  const [photonCredentials, setPhotonCredentials] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const value = (key: string) => values[key] ?? "";
  const setValue = (key: string, next: string) =>
    setValues((current) => ({ ...current, [key]: next }));

  const fields = meta.fields.filter((field) => provider !== "imessage" || field.mode === mode);
  const credentialsComplete = fields.every((field) => field.optional || value(field.key).trim());
  const inviteUrl = provider === "discord" ? discordInviteUrl(value("applicationId")) : null;

  const reset = () => {
    setStep(0);
    setMode("hosted");
    setName("");
    setPhotonCredentials("");
    setValues({});
    setBotId(bots[0]?.id ?? CONNECT_LATER);
    setConnectError(null);
    setBusy(false);
  };

  const save = async () => {
    if (busy || !name.trim() || !credentialsComplete) return;
    setBusy(true);
    const random = crypto.getRandomValues(new Uint32Array(4));
    const connectionId = ChannelConnectionId.make(`channel-${[...random].join("-")}`);
    const result = await saveConnection({
      environmentId,
      input: buildChannelConnectionSaveInput({
        connectionId,
        name: name.trim(),
        provider,
        mode,
        values,
      }),
    });
    if (result._tag === "Failure") {
      setBusy(false);
      toastManager.add({ type: "error", title: "Could not save channel" });
      return;
    }
    if (botId !== CONNECT_LATER) {
      const attached = await attach({
        environmentId,
        input: { botId: BotId.make(botId), connectionId, provider },
      });
      if (attached._tag === "Failure") {
        setBusy(false);
        onSaved(connectionId);
        setConnectError(
          `${meta.label} rejected these credentials. The connection was saved. Check the tokens in the ${meta.label} console, then connect ${bots.find((bot) => bot.id === botId)?.name ?? "the bot"} from the card.`,
        );
        return;
      }
    }
    setBusy(false);
    onSaved(connectionId);
    onOpenChange(false);
    reset();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            <meta.icon className="size-5 shrink-0" aria-hidden />
            Connect {meta.label}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 px-6 pb-6">
          <div
            className="flex items-center gap-1.5"
            aria-label={`Step ${step + 1} of ${STEPS.length}`}
          >
            {STEPS.map((label, index) => (
              <span
                key={label}
                className={cn(
                  "h-1 flex-1 rounded-full transition-colors",
                  index <= step ? "bg-foreground/70" : "bg-muted",
                )}
              />
            ))}
          </div>

          {step === 0 ? (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">{meta.tagline}.</p>
              <ol className="flex list-none flex-col gap-2.5">
                {meta.steps.map((instruction, index) => (
                  <li key={instruction} className="flex gap-2.5 text-sm">
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground">
                      {index + 1}
                    </span>
                    <span className="min-w-0">{instruction}</span>
                  </li>
                ))}
              </ol>
              <Button
                variant="outline"
                render={<a href={meta.consoleUrl} target="_blank" rel="noreferrer" />}
              >
                <ExternalLinkIcon className="size-4" />
                {meta.consoleLabel}
              </Button>
            </div>
          ) : null}

          {step === 1 ? (
            <div className="flex flex-col gap-2.5">
              {provider === "imessage" ? (
                <Select value={mode} onValueChange={(next) => next && setMode(next)}>
                  <SelectTrigger aria-label="Photon connection type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="hosted">Photon hosted</SelectItem>
                    <SelectItem value="self-hosted">Photon self-hosted</SelectItem>
                  </SelectPopup>
                </Select>
              ) : null}
              {provider === "imessage" && mode === "hosted" ? (
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
                fields.map((field) => (
                  <Input
                    key={field.key}
                    aria-label={`${meta.label} ${field.label}`}
                    type={field.sensitive ? "password" : "text"}
                    placeholder={field.placeholder}
                    value={value(field.key)}
                    onChange={(event) => setValue(field.key, event.currentTarget.value)}
                    onPaste={
                      provider === "slack"
                        ? (event) => {
                            const target = slackPasteTarget(event.clipboardData.getData("text"));
                            if (target && target !== field.key) {
                              event.preventDefault();
                              setValue(target, event.clipboardData.getData("text").trim());
                            }
                          }
                        : undefined
                    }
                  />
                ))
              )}
              {inviteUrl ? (
                <Button
                  variant="outline"
                  render={<a href={inviteUrl} target="_blank" rel="noreferrer" />}
                >
                  <ExternalLinkIcon className="size-4" />
                  Invite bot to your server
                </Button>
              ) : null}
            </div>
          ) : null}

          {step === 2 ? (
            <div className="flex flex-col gap-2.5">
              <Input
                aria-label="Connection name"
                placeholder={`Name, e.g. ${meta.label} line`}
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
              />
              {connectError ? (
                <p role="alert" className="text-sm text-amber-600 dark:text-amber-400">
                  {connectError}
                </p>
              ) : null}
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">Bot that answers</span>
                <Select value={botId} onValueChange={(next) => next && setBotId(next)}>
                  <SelectTrigger aria-label="Bot that answers">
                    <SelectValue>
                      {bots.find((bot) => bot.id === botId)?.name ?? "Connect later"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value={CONNECT_LATER}>Connect later</SelectItem>
                    {bots.map((bot) => (
                      <SelectItem key={bot.id} value={bot.id}>
                        {bot.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              disabled={step === 0 || busy}
              onClick={() => setStep((current) => Math.max(0, current - 1))}
            >
              Back
            </Button>
            {step < 2 ? (
              <Button
                disabled={step === 1 && !credentialsComplete}
                onClick={() => setStep((current) => current + 1)}
              >
                Continue
              </Button>
            ) : (
              <Button
                disabled={busy || !name.trim() || !credentialsComplete}
                onClick={() => void save()}
              >
                {botId === CONNECT_LATER ? "Save connection" : "Connect"}
              </Button>
            )}
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
