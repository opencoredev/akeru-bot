import { Predicate } from "effect";
import {
  type BotId,
  type ChannelOwnerIdentity,
  type ChannelOwnerProvider,
  type ChannelProvider,
  CHANNEL_ALLOWED_USER_LIMIT,
  CHANNEL_OWNER_PROVIDERS,
  type EnvironmentId,
} from "@akeru/contracts";
import { useEffect, useState } from "react";

import { useI18n } from "../../i18n";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { botEnvironment } from "../../state/bots";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { channelProviderMeta } from "./channelProviderMeta";
import { SettingsMessageRow } from "./settingsDetailLayout";
import { SettingsSection } from "./settingsLayout";

/** Link codes expire on the server after ten minutes; the page stops showing them then too. */
const LINK_CODE_LIFETIME_MS = 10 * 60 * 1000;

export const isOwnerGatedProvider = (provider: ChannelProvider): provider is ChannelOwnerProvider =>
  CHANNEL_OWNER_PROVIDERS.some((candidate) => candidate === provider);

/** Splits pasted IDs on commas, spaces, or new lines and drops repeats. */
export const parseAllowedUserIds = (text: string) => [
  ...new Set(
    text
      .split(/[\s,]+/u)
      .map((id) => id.trim())
      .filter(Boolean),
  ),
];

/** The accounts the environment owner linked for one provider, each with a way to unlink it. */
export function ChannelLinkedAccounts({
  environmentId,
  provider,
}: {
  readonly environmentId: EnvironmentId;
  readonly provider: ChannelOwnerProvider;
}) {
  const { t } = useI18n();
  const owners = useEnvironmentSettings(environmentId, (settings) => settings.channelOwners);
  const removeOwner = useAtomCommand(botEnvironment.channels.removeOwner, { reportFailure: false });
  const [removing, setRemoving] = useState<string | null>(null);
  const linked = owners.filter((owner) => owner.provider === provider);

  const remove = async (owner: ChannelOwnerIdentity) => {
    const key = `${owner.workspaceId}:${owner.userId}`;
    setRemoving(key);

    const result = await removeOwner({
      environmentId,
      input: { provider, workspaceId: owner.workspaceId, userId: owner.userId },
    });

    setRemoving(null);

    if (Predicate.isTagged(result, "Failure")) {
      toastManager.add({ type: "error", title: t("Could not unlink this account") });
    }
  };

  return (
    <SettingsSection id="channel-linked-accounts" title={t("Linked accounts")}>
      {linked.length === 0 ? (
        <SettingsMessageRow>
          {t(
            "No linked accounts yet. Bots answer only linked accounts. Create a link code on a connection above and send it to the bot in a direct message.",
          )}
        </SettingsMessageRow>
      ) : (
        linked.map((owner) => {
          const key = `${owner.workspaceId}:${owner.userId}`;

          return (
            <div
              key={key}
              data-settings-row=""
              className="flex min-h-8 items-center gap-3 rounded-xl px-3 py-3 sm:px-4"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">
                  {owner.displayName ?? owner.userId}
                </p>
                <p className="truncate text-13px text-muted-foreground/80">
                  {provider === "slack"
                    ? t("{user} in workspace {workspace}", {
                        user: owner.userId,
                        workspace: owner.workspaceId,
                      })
                    : owner.userId}
                </p>
              </div>
              <Button
                size="xs"
                variant="outline"
                disabled={removing !== null}
                onClick={() => void remove(owner)}
              >
                {t("Unlink")}
              </Button>
            </div>
          );
        })
      )}
    </SettingsSection>
  );
}

type ChannelBotAccessControlsProps = {
  readonly environmentId: EnvironmentId;
  readonly provider: ChannelOwnerProvider;
  readonly botId: BotId;
  readonly botName: string;
  /** Whether the bot's channel is running. A link code works only while it listens. */
  readonly connected: boolean;
  /**
   * When the running connection started. Each successful connect sets a new value and a
   * disconnect deletes the server's pending codes, so a code is shown only for the connection
   * it was made on. A connect takes network round trips, so two rarely share a millisecond
   * timestamp; a backward clock adjustment could repeat one and briefly show a deleted code.
   */
  readonly connectedAt: string | null;
};

/**
 * Link code, allowlist, and reply setting for the bot assigned to one Slack or Discord connection.
 * The controls start fresh for each environment, bot, and provider, so a connection reassigned to
 * another bot never saves the previous bot's drafts or shows its link code.
 */
export function ChannelBotAccessControls(props: ChannelBotAccessControlsProps) {
  return (
    <BotAccessControls key={`${props.environmentId}:${props.botId}:${props.provider}`} {...props} />
  );
}

/** A link code and the connection it was created on. */
interface IssuedLinkCode {
  readonly code: string;
  readonly connectedAt: string | null;
}

function BotAccessControls({
  environmentId,
  provider,
  botId,
  botName,
  connected,
  connectedAt,
}: ChannelBotAccessControlsProps) {
  const { t } = useI18n();
  const access = useEnvironmentSettings(environmentId, (settings) => settings.channelBotAccess);

  // This provider's entry, or the one saved before access was per provider.
  const saved =
    access.find((entry) => entry.botId === botId && entry.provider === provider) ??
    access.find((entry) => entry.botId === botId && entry.provider === undefined);

  const savedIds = (saved?.allowedUserIds ?? []).join(", ");
  const savedReply = saved?.replyToOthers ?? false;
  const [draftIds, setDraftIds] = useState<string | null>(null);
  const [draftReply, setDraftReply] = useState<boolean | null>(null);
  const [issuedCode, setIssuedCode] = useState<IssuedLinkCode | null>(null);
  const [busy, setBusy] = useState(false);

  // Shown only on the connection it was made on, which also drops a reply that lands after a
  // reconnect. A failed reconnect that keeps the old connection keeps its code.
  const linkCode =
    connected &&
    connectedAt !== null &&
    issuedCode !== null &&
    issuedCode.connectedAt === connectedAt
      ? issuedCode.code
      : null;

  const createLinkCode = useAtomCommand(botEnvironment.channels.createLinkCode, {
    reportFailure: false,
  });

  const setAccess = useAtomCommand(botEnvironment.channels.setAccess, { reportFailure: false });

  const idsText = draftIds ?? savedIds;
  const replyToOthers = draftReply ?? savedReply;
  const allowedUserIds = parseAllowedUserIds(idsText);
  const tooMany = allowedUserIds.length > CHANNEL_ALLOWED_USER_LIMIT;
  const dirty = (draftIds !== null && idsText !== savedIds) || replyToOthers !== savedReply;

  // One timer per issued code, so the page never offers a code the server no longer accepts.
  useEffect(() => {
    if (issuedCode === null) return;
    const timer = window.setTimeout(() => setIssuedCode(null), LINK_CODE_LIFETIME_MS);

    return () => window.clearTimeout(timer);
  }, [issuedCode]);

  const createCode = async () => {
    const requestedOn = connectedAt;
    setBusy(true);
    const result = await createLinkCode({ environmentId, input: { botId, provider } });
    setBusy(false);

    if (Predicate.isTagged(result, "Failure")) {
      toastManager.add({ type: "error", title: t("Could not create a link code") });

      return;
    }

    setIssuedCode({ code: result.value, connectedAt: requestedOn });
  };

  const save = async () => {
    setBusy(true);
    const submittedIds = idsText;
    const submittedReply = replyToOthers;

    const result = await setAccess({
      environmentId,
      input: { botId, provider, allowedUserIds, replyToOthers },
    });

    setBusy(false);

    if (Predicate.isTagged(result, "Failure")) {
      toastManager.add({ type: "error", title: t("Could not save who this bot answers") });

      return;
    }

    // Keep an edit made while the save was in flight; it was never sent.
    setDraftIds((current) => (current === submittedIds ? null : current));
    setDraftReply((current) => (current === submittedReply ? null : current));
  };

  return (
    <div className="space-y-3 border-t border-border/60 pt-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1 text-13px text-muted-foreground/80">
          {linkCode === null ? (
            t("{bot} answers only linked accounts and the people you add below.", {
              bot: botName,
            })
          ) : (
            <>
              {t("Send this code to {bot} in a direct message within 10 minutes:", {
                bot: botName,
              })}{" "}
              <code
                aria-label={t("Link code")}
                className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-sm tracking-widest text-foreground"
              >
                {linkCode}
              </code>
            </>
          )}
        </p>
        <Button
          size="xs"
          variant="outline"
          disabled={busy || !connected}
          onClick={() => void createCode()}
        >
          {linkCode === null ? t("Create link code") : t("Create new code")}
        </Button>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <label
          htmlFor={`channel-allowlist-${botId}`}
          className="text-xs font-medium text-muted-foreground"
        >
          {t("Also answer these {provider} user IDs", {
            provider: channelProviderMeta(provider).label,
          })}
        </label>
        <Input
          id={`channel-allowlist-${botId}`}
          size="sm"
          placeholder={provider === "slack" ? "U012ABCDEF, U034GHIJKL" : "123456789012345678"}
          value={idsText}
          aria-invalid={tooMany || undefined}
          onChange={(event) => setDraftIds(event.currentTarget.value)}
        />
        {tooMany ? (
          <p className="text-xs text-destructive-foreground">
            {t("Add at most {count} user IDs.", { count: CHANNEL_ALLOWED_USER_LIMIT })}
          </p>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <label className="flex min-w-0 flex-1 items-center gap-2 text-13px text-foreground">
          <Switch
            checked={replyToOthers}
            onCheckedChange={(checked) => setDraftReply(Boolean(checked))}
          />
          {t("Tell other people whose bot this is when they mention it")}
        </label>
        <Button size="xs" disabled={!dirty || tooMany || busy} onClick={() => void save()}>
          {t("Save")}
        </Button>
      </div>
    </div>
  );
}
