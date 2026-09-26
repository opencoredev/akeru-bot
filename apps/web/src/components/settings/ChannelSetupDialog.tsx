import {
  BotId,
  ChannelConnectionId,
  type ChannelProvider,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import {
  channelFailureReason,
  channelPickerProjectId,
} from "@t3tools/client-runtime/channel-presentation";
import { defaultProjectIdForBot } from "@t3tools/shared/channelProject";
import { ExternalLinkIcon } from "lucide-react";
import { useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";

import { channelFailureCategoryOf, isChannelIdentityConflict } from "../../channelAccess";
import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";
import { botEnvironment } from "../../state/bots";
import { environmentSnapshotAtom } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { parsePhotonHostedCredentials } from "./BotChannelsSettings";
import { ChannelProjectSelect } from "./ChannelProjectSelect";
import { channelProviderMeta, discordInviteUrl, slackPasteTarget } from "./channelProviderMeta";

const STEPS = ["Set up", "Credentials", "Connect"] as const;
const CONNECT_LATER = "connect-later";
const PHOTON_MODE_LABELS = {
  hosted: "Photon hosted",
  "self-hosted": "Photon self-hosted",
} as const;

/**
 * An assigned connection whose credentials the dialog replaces. The dialog saves the new
 * credentials as a new connection and only removes the old one after the bot connects, so a bad
 * token never takes a working channel down.
 */
export interface ChannelReplacement {
  readonly connectionId: ChannelConnectionId;
  readonly name: string;
  readonly botId: BotId;
  readonly projectId: ProjectId | undefined;
}

/** The Photon connection type picker. The trigger shows the option label, not the raw mode. */
export function PhotonModeSelect({
  mode,
  onChange,
}: {
  readonly mode: keyof typeof PHOTON_MODE_LABELS;
  readonly onChange: (mode: keyof typeof PHOTON_MODE_LABELS) => void;
}) {
  return (
    <Select value={mode} onValueChange={(next) => next && onChange(next)}>
      <SelectTrigger aria-label="Photon connection type">
        <SelectValue>{PHOTON_MODE_LABELS[mode]}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value="hosted">{PHOTON_MODE_LABELS.hosted}</SelectItem>
        <SelectItem value="self-hosted">{PHOTON_MODE_LABELS["self-hosted"]}</SelectItem>
      </SelectPopup>
    </Select>
  );
}

const newConnectionId = () =>
  ChannelConnectionId.make(`channel-${[...crypto.getRandomValues(new Uint32Array(4))].join("-")}`);

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
  replacing = null,
}: {
  readonly environmentId: EnvironmentId;
  readonly provider: ChannelProvider;
  readonly bots: ReadonlyArray<{ readonly id: BotId; readonly name: string }>;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSaved: (connectionId: ChannelConnectionId) => void;
  readonly replacing?: ChannelReplacement | null;
}) {
  const { t } = useI18n();
  const meta = channelProviderMeta(provider);
  const saveConnection = useAtomCommand(botEnvironment.channels.saveConnection, {
    reportFailure: false,
  });
  const attach = useAtomCommand(botEnvironment.channels.attach, { reportFailure: false });
  const detach = useAtomCommand(botEnvironment.channels.detach, { reportFailure: false });
  const deleteConnection = useAtomCommand(botEnvironment.channels.deleteConnection, {
    reportFailure: false,
  });
  const snapshot = useAtomValue(environmentSnapshotAtom(environmentId));
  const initialBotId = replacing?.botId ?? bots[0]?.id ?? CONNECT_LATER;
  const [botId, setBotId] = useState<string>(initialBotId);
  const [pickedProjectId, setPickedProjectId] = useState<ProjectId | null>(
    replacing?.projectId ?? null,
  );
  const liveProjects = snapshot?.projects ?? [];
  const projectId = channelPickerProjectId({
    selected: pickedProjectId,
    binding: undefined,
    hint: snapshot
      ? defaultProjectIdForBot(snapshot, botId === CONNECT_LATER ? null : BotId.make(botId))
      : null,
    liveProjects,
  });
  const projectMissing = botId !== CONNECT_LATER && projectId === null;
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<"hosted" | "self-hosted">("hosted");
  const [name, setName] = useState(replacing?.name ?? "");
  const [photonCredentials, setPhotonCredentials] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  // The new connection kept after a failed detach, until the bot's assignment shows whether the
  // old connection survived (retry from scratch) or was removed (reconnect with this one).
  // Closing the dialog keeps it, since a snapshot that has not synced yet can still show the old
  // assignment after the detach removed it.
  const [unconfirmed, setUnconfirmed] = useState<ChannelConnectionId | null>(null);
  const savedConnection = useRef<{
    connectionId: ChannelConnectionId;
    name: string;
    mode: typeof mode;
    values: typeof values;
  } | null>(null);
  const value = (key: string) => values[key] ?? "";
  const setValue = (key: string, next: string) =>
    setValues((current) => ({ ...current, [key]: next }));

  const fields = meta.fields.filter((field) => provider !== "imessage" || field.mode === mode);
  const credentialsComplete = fields.every((field) => field.optional || value(field.key).trim());
  const inviteUrl = provider === "discord" ? discordInviteUrl(value("applicationId")) : null;

  // Read from the live snapshot so the copy follows the server's view of the assignment.
  const oldStillAssigned =
    replacing !== null &&
    snapshot?.bots
      ?.find((bot) => bot.id === replacing.botId)
      ?.channelBindings?.find((binding) => binding.provider === provider)?.connectionId ===
      replacing.connectionId;
  const unassigned = unconfirmed !== null && !oldStillAssigned;

  const reset = () => {
    setUnconfirmed(null);
    savedConnection.current = null;
    setStep(0);
    setMode("hosted");
    setName(replacing?.name ?? "");
    setPhotonCredentials("");
    setValues({});
    setBotId(initialBotId);
    setPickedProjectId(replacing?.projectId ?? null);
    setConnectError(null);
    setBusy(false);
  };

  const conflictCopy = t(
    "Another bot already uses this account. Unassign it there, then connect again.",
  );
  const failureReason = (result: Parameters<typeof channelFailureCategoryOf>[0]) => {
    const category = channelFailureCategoryOf(result);
    return category ? channelFailureReason(category, provider, t) : null;
  };

  const finish = (connectionId: ChannelConnectionId) => {
    setBusy(false);
    onSaved(connectionId);
    onOpenChange(false);
    reset();
  };

  // Detaches the old connection, connects the new one, and puts the old one back on failure.
  const replace = async (current: ChannelReplacement) => {
    if (projectId === null) return;
    // After a detach removed the old connection, reconnect with the kept one instead.
    // It stays kept until it attaches or the old connection is restored, so a failed retry
    // still reconnects instead of detaching a binding that is already gone.
    const reconnecting = unassigned ? unconfirmed : null;
    if (unconfirmed !== null && !reconnecting) {
      await deleteConnection({ environmentId, input: { connectionId: unconfirmed } });
      setUnconfirmed(null);
    }
    const connectionId = reconnecting ?? newConnectionId();
    const saved = await saveConnection({
      environmentId,
      input: buildChannelConnectionSaveInput({
        connectionId,
        name: name.trim(),
        provider,
        mode,
        values,
      }),
    });
    if (saved._tag === "Failure") {
      setBusy(false);
      toastManager.add({ type: "error", title: "Could not save channel" });
      return;
    }
    const discardNew = () =>
      deleteConnection({ environmentId, input: { connectionId } }).then(() => undefined);
    const detached = reconnecting
      ? null
      : await detach({
          environmentId,
          input: { botId: current.botId, provider },
        });
    if (detached?._tag === "Failure") {
      // The detach can fail after it removed the old connection, when the old listener does not
      // stop. Keep the new connection until the assignment shows which happened.
      setBusy(false);
      setUnconfirmed(connectionId);
      onSaved(connectionId);
      return;
    }
    const attached = await attach({
      environmentId,
      input: { botId: current.botId, connectionId, provider, projectId },
    });
    if (attached._tag === "Failure") {
      const restored = await attach({
        environmentId,
        input: {
          botId: current.botId,
          connectionId: current.connectionId,
          provider,
          projectId: current.projectId ?? projectId,
        },
      });
      if (restored._tag === "Failure") {
        // The failed attach may still have persisted a binding to the new connection.
        onSaved(connectionId);
      } else {
        await discardNew();
        setUnconfirmed(null);
      }
      setBusy(false);
      const reason = failureReason(attached);
      setConnectError(
        restored._tag === "Failure"
          ? isChannelIdentityConflict(attached)
            ? `${conflictCopy} ${t("The old connection could not be restored.")}`
            : [
                t("Could not connect with the new credentials or restore the old connection."),
                reason,
              ]
                .filter(Boolean)
                .join(" ")
          : isChannelIdentityConflict(attached)
            ? conflictCopy
            : [
                t("Could not connect with the new credentials. The old connection is unchanged."),
                reason,
              ]
                .filter(Boolean)
                .join(" "),
      );
      return;
    }
    const removedOld = await deleteConnection({
      environmentId,
      input: { connectionId: current.connectionId },
    });
    if (removedOld._tag === "Failure") {
      toastManager.add({
        type: "warning",
        title: t("New credentials connected"),
        description: t("The old connection could not be removed. Delete it from the channel list."),
      });
    }
    finish(connectionId);
  };

  const save = async () => {
    if (busy || !name.trim() || !credentialsComplete || projectMissing) return;
    if (replacing) {
      setBusy(true);
      setConnectError(null);
      await replace(replacing);
      return;
    }
    setBusy(true);
    setConnectError(null);
    const saved = savedConnection.current;
    const connectionId = saved?.connectionId ?? newConnectionId();
    if (!saved || saved.name !== name.trim() || saved.mode !== mode || saved.values !== values) {
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
      savedConnection.current = { connectionId, name: name.trim(), mode, values };
    }
    if (botId !== CONNECT_LATER && projectId !== null) {
      const attached = await attach({
        environmentId,
        input: { botId: BotId.make(botId), connectionId, provider, projectId },
      });
      if (attached._tag === "Failure") {
        setBusy(false);
        onSaved(connectionId);
        const reason = failureReason(attached);
        setConnectError(
          isChannelIdentityConflict(attached)
            ? conflictCopy
            : reason
              ? t("{name} is saved but could not connect. {reason}", {
                  name: name.trim(),
                  reason,
                })
              : t(
                  "{name} is saved but could not connect. Try again or check the connection settings.",
                  { name: name.trim() },
                ),
        );
        return;
      }
    }
    finish(connectionId);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            <meta.icon className="size-5 shrink-0" aria-hidden />
            {replacing
              ? t("Update {name} credentials", { name: meta.label })
              : `Connect ${meta.label}`}
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
              {provider === "imessage" ? <PhotonModeSelect mode={mode} onChange={setMode} /> : null}
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
              ) : unconfirmed !== null ? (
                <p role="alert" className="text-sm text-amber-600 dark:text-amber-400">
                  {unassigned
                    ? t(
                        "Could not update the credentials, and {name} is now unassigned from this channel. Reconnect to use the new credentials.",
                        { name: botName },
                      )
                    : t("Could not update the credentials. The old connection is unchanged.")}
                </p>
              ) : null}
              {replacing ? null : (
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    Bot that answers
                  </span>
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
              )}
              {botId !== CONNECT_LATER ? (
                <>
                  <ChannelProjectSelect
                    projects={liveProjects}
                    value={projectId}
                    onChange={setPickedProjectId}
                    label="Project for channel turns"
                    disabled={busy}
                  />
                  <p
                    role="note"
                    className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground"
                  >
                    {t(
                      "Anyone who can message this bot can ask it to work in the chosen project with its enabled tools.",
                    )}
                  </p>
                </>
              ) : null}
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
                disabled={busy || !name.trim() || !credentialsComplete || projectMissing}
                onClick={() => void save()}
              >
                {replacing
                  ? unassigned
                    ? t("Reconnect")
                    : t("Save and reconnect")
                  : botId === CONNECT_LATER
                    ? "Save connection"
                    : "Connect"}
              </Button>
            )}
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
