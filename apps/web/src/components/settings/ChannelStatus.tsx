import type { ChannelBinding, ChannelConnectionProfile } from "@t3tools/contracts";
import type { ChannelRepairAction } from "@t3tools/client-runtime/channel-presentation";

import type { ReactNode } from "react";

import { useI18n } from "../../i18n";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

type StatusBinding = Pick<ChannelBinding, "status" | "lastError">;

/**
 * The webhook URL the server built for a connection, when it advertises one. Never derived from
 * the browser origin, because the browser may reach the server over a private address.
 */
export function channelWebhookUrl(connection: ChannelConnectionProfile): string | null {
  return "webhookUrl" in connection && typeof connection.webhookUrl === "string"
    ? connection.webhookUrl
    : null;
}

/** One status badge for a channel card. `ownerName` is the bot the connection is assigned to. */
export function ChannelStatusBadge({
  binding,
  ownerName,
  needsProject,
}: {
  readonly binding: StatusBinding | undefined;
  readonly ownerName: string | undefined;
  readonly needsProject: boolean;
}) {
  const { t } = useI18n();
  if (!binding || ownerName === undefined) {
    return (
      <Badge variant="secondary" size="sm">
        {t("Unassigned")}
      </Badge>
    );
  }
  const warning = (label: string) => (
    <Badge variant="warning" size="sm">
      {label}
    </Badge>
  );
  if (needsProject) return warning(t("Choose another project"));
  switch (binding.status) {
    case "connecting":
      return (
        <Badge variant="secondary" size="sm">
          {t("Connecting…")}
        </Badge>
      );
    case "not-live":
      return warning(t("Not live"));
    case "failed":
      return warning(t("Connection failed"));
    case "needs-reconnect":
      return warning(t("Needs reconnect"));
    case "blocked":
      return warning(t("Choose another project"));
    case "disconnected":
      return (
        <Badge variant="secondary" size="sm">
          {t("Disconnected · {name}", { name: ownerName })}
        </Badge>
      );
    case "connected":
      return binding.lastError ? (
        warning(t("Needs attention · {name}", { name: ownerName }))
      ) : (
        <Badge variant="success" size="sm">
          {t("Assigned to {name}", { name: ownerName })}
        </Badge>
      );
  }
}

/** The explanation under a channel badge, or nothing when the channel is healthy. */
export function ChannelStatusNotice({
  binding,
  needsProject,
  webhookUrl,
}: {
  readonly binding: StatusBinding | undefined;
  readonly needsProject: boolean;
  readonly webhookUrl: string | null;
}) {
  const { t } = useI18n();
  const notice = (children: ReactNode) => (
    <div role="status" className="break-words text-xs text-amber-600 dark:text-amber-400">
      {children}
    </div>
  );
  if (!binding) return null;
  if (needsProject) {
    return notice(
      t("The project for this channel is unavailable. Choose another project to reconnect it."),
    );
  }
  if (binding.status === "not-live") {
    return notice(
      <>
        <p>
          {t(
            "WhatsApp needs a public HTTPS address to receive messages. Give this environment a public URL, then reconnect.",
          )}
        </p>
        {webhookUrl ? (
          <p className="mt-1 text-muted-foreground">
            {t("Webhook URL")}: <code className="break-all font-mono">{webhookUrl}</code>
          </p>
        ) : null}
      </>,
    );
  }
  // Server failure text is fixed per category and never carries provider error details.
  return binding.lastError ? notice(binding.lastError) : null;
}

/**
 * The repair controls for a binding, driven by `channelRepairAction`. Returns nothing for
 * actions a client cannot take, such as setting a public URL, which the notice explains instead.
 * Checking delivery links to the provider console, so callers hide their own provider link then.
 */
export function ChannelRepairButton({
  action,
  status,
  disabled,
  managementUrl,
  onRepair,
}: {
  readonly action: ChannelRepairAction;
  readonly status: ChannelBinding["status"];
  readonly disabled: boolean;
  readonly managementUrl: string | undefined;
  readonly onRepair: (
    action: "connect" | "reconnect" | "update-credentials" | "choose-project",
  ) => void;
}) {
  const { t } = useI18n();
  switch (action) {
    case "none":
    case "configure-public-url":
      return null;
    case "wait":
      return (
        <Button variant="outline" disabled>
          {t("Connecting…")}
        </Button>
      );
    case "check-delivery":
      return (
        <>
          {managementUrl ? (
            <Button
              variant="outline"
              render={<a href={managementUrl} target="_blank" rel="noreferrer" />}
            >
              {t("Check the channel")}
            </Button>
          ) : null}
          {status === "failed" ? (
            <Button disabled={disabled} onClick={() => onRepair("reconnect")}>
              {t("Reconnect")}
            </Button>
          ) : null}
        </>
      );
    case "connect":
      return (
        <Button disabled={disabled} onClick={() => onRepair(action)}>
          {t("Connect")}
        </Button>
      );
    case "reconnect":
      return (
        <Button disabled={disabled} onClick={() => onRepair(action)}>
          {t("Reconnect")}
        </Button>
      );
    case "update-credentials":
      return (
        <Button disabled={disabled} onClick={() => onRepair(action)}>
          {t("Update credentials")}
        </Button>
      );
    case "choose-project":
      return (
        <Button disabled={disabled} onClick={() => onRepair(action)}>
          {t("Reconnect in this project")}
        </Button>
      );
  }
}
