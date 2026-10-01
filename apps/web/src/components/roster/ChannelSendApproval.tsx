import type {
  BotId,
  ChannelMessageOrigin,
  EnvironmentId,
  MessageId,
  OrchestrationMessage,
  ThreadId,
} from "@akeru/contracts";
import { channelDeliveryLabel } from "@akeru/client-runtime/channel-origin-presentation";
import { useState } from "react";

import { useI18n } from "~/i18n";
import { cn } from "~/lib/utils";
import { botEnvironment } from "../../state/bots";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { channelProviderLabel } from "./botConversationPresentation";

export interface ChannelApprovalTarget {
  readonly environmentId: EnvironmentId;
  readonly botId: BotId;
  readonly threadId: ThreadId;
  /** Null when the inbound channel message is not loaded yet. */
  readonly origin: ChannelMessageOrigin | null;
  readonly sent: boolean;
  /** Only channel admins with a live binding may trigger a send. */
  readonly canSend: boolean;
}

/**
 * Delivery status for a reply to a channel message, with a Send action for channel
 * admins while the reply has not gone out yet.
 */
export function ChannelSendApproval({
  environmentId,
  botId,
  origin,
  threadId,
  messageId,
  delivery,
  sent,
  canSend,
}: {
  readonly environmentId: EnvironmentId;
  readonly botId: BotId;
  readonly origin: ChannelMessageOrigin | null;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly delivery: OrchestrationMessage["channelDelivery"];
  readonly sent: boolean;
  readonly canSend: boolean;
}) {
  const { t } = useI18n();
  const send = useAtomCommand(botEnvironment.channels.send, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const delivered = sent || submitted || delivery === "sent";
  const label = origin ? channelProviderLabel(origin.provider) : null;

  const deliveryLabel =
    delivery && (!delivered || label === null)
      ? channelDeliveryLabel(delivery, origin?.provider)
      : null;

  return (
    <div className="mt-2 flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs">
      <span
        className={cn(
          "min-w-0 flex-1",
          deliveryLabel?.tone === "error"
            ? "text-destructive"
            : deliveryLabel?.tone === "warning"
              ? "text-warning-foreground"
              : "text-muted-foreground",
        )}
      >
        {delivered && label !== null
          ? t("Sent to {channel}", { channel: label })
          : (deliveryLabel?.message ??
            (canSend && label !== null
              ? t("Send this reply to {channel}?", { channel: label })
              : null))}
      </span>
      {canSend &&
      label !== null &&
      !delivered &&
      delivery !== "pending" &&
      delivery !== "unknown" ? (
        <Button
          size="xs"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void send({
              environmentId,
              input: { botId, threadId, messageId },
            }).then((result) => {
              setBusy(false);

              if (result._tag === "Failure") {
                toastManager.add({
                  type: "error",
                  title: t("Could not send to {channel}", { channel: label }),
                });
              } else {
                setSubmitted(true);
              }
            });
          }}
        >
          {busy ? t("Sending…") : t("Send")}
        </Button>
      ) : null}
    </div>
  );
}
