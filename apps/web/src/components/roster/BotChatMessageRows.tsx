import type {
  AkeruPluginSearchResult,
  BotId,
  ChannelMessageOrigin,
  EnvironmentId,
  MessageId,
  OrchestrationMessage,
  ScopedThreadRef,
  ServerProviderSkill,
  ThreadId,
} from "@t3tools/contracts";
import type { ReplyPlaybackSession } from "@t3tools/client-runtime/reply-playback";
import { SmilePlusIcon } from "lucide-react";
import { memo, useCallback, useState } from "react";

import { useI18n } from "~/i18n";
import {
  channelDeliveryLabel,
  channelOriginLabel,
} from "@t3tools/client-runtime/channel-origin-presentation";
import { replyPlaybackControlProps } from "~/lib/replyPlaybackThread";
import { cn } from "~/lib/utils";
import { botEnvironment } from "../../state/bots";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import {
  MessageControls,
  type MessageReactionOption,
  reactionOptionFromEmoji,
  selectedReactionForPerson,
} from "../chat/MessageControls";
import { MessageReactions } from "../chat/MessageReactions";
import { PluginSearchResultCard } from "../chat/PluginSearchResultCard";
import { SentMessageText } from "../chat/SentMessageText";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BotAvatarView } from "./BotAvatarView";
import { BotMessageAttachments } from "./BotMessageAttachments";
import { BotStepMeter } from "./BotStepMeter";
import type { BotStepMeterData } from "./botStepMeter.logic";
import { channelProviderLabel } from "./botConversationPresentation";
import type { Bot } from "./types";

const NO_ENVIRONMENT = "" as EnvironmentId;
// Held open while a control's menu is, so the controls never slip out from under the pointer.
const HOVER_CONTROLS_CLASS =
  "opacity-0 transition-opacity pointer-coarse:opacity-100 focus-within:opacity-100 group-hover/message:opacity-100 has-[[aria-expanded=true]]:opacity-100 has-[[data-popup-open]]:opacity-100 max-md:opacity-100";
// Offscreen rows skip layout and paint; the intrinsic size keeps the scrollbar steady.
const ROW_VISIBILITY_CLASS = "[content-visibility:auto] [contain-intrinsic-size:auto_96px]";

export type MessageReplyHandler = (messageId: MessageId, label: string, text: string) => void;
export type MessageReactionHandler = (
  messageId: MessageId,
  current: MessageReactionOption | null,
  next: MessageReactionOption | null,
) => void;

export interface PluginResultEntry {
  readonly id: string;
  readonly result: AkeruPluginSearchResult;
}

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

/** A stable reaction updater for memoized rows; it only changes with the linked thread. */
export function useMessageReactionUpdater(threadRef: ScopedThreadRef | null) {
  const { t } = useI18n();
  const setMessageReaction = useAtomCommand(threadEnvironment.setMessageReaction, {
    reportFailure: false,
  });
  return useCallback<MessageReactionHandler>(
    (messageId, current, next) => {
      if (!threadRef) return;
      const dispatch = (emoji: MessageReactionOption, present: boolean) =>
        setMessageReaction({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, messageId, emoji, present },
        });
      void (async () => {
        if (current && current !== next) {
          const removed = await dispatch(current, false);
          if (removed._tag === "Failure") {
            toastManager.add({ type: "error", title: t("Could not update reaction") });
            return;
          }
        }
        if (next) {
          const added = await dispatch(next, true);
          if (added._tag === "Failure") {
            toastManager.add({ type: "error", title: t("Could not update reaction") });
          }
        }
      })();
    },
    [setMessageReaction, t, threadRef],
  );
}

function UnavailableReactionControl({
  selectedReaction,
}: {
  readonly selectedReaction: MessageReactionOption | null;
}) {
  const { t } = useI18n();
  const unavailableReason = t("Reactions are unavailable until this chat is ready");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={unavailableReason}
            className="disabled:pointer-events-auto"
            disabled
            size="icon-xs"
            variant="ghost"
          />
        }
      >
        {selectedReaction ? (
          <span className="text-sm [font-family:'Apple_Color_Emoji','Segoe_UI_Emoji',sans-serif]">
            {selectedReaction}
          </span>
        ) : (
          <SmilePlusIcon className="size-3.5" />
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">{unavailableReason}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Reaction picker plus the chip toggles for one message. A null handler means the chat
 * is not linked yet, so the picker explains why it is disabled.
 */
function reactionProps(
  message: OrchestrationMessage,
  selectedReaction: MessageReactionOption | null,
  onReactionChange: MessageReactionHandler | null,
) {
  if (!onReactionChange) return { controls: {}, chips: {} };
  return {
    controls: {
      onReactionChange: (next: MessageReactionOption | null) =>
        onReactionChange(message.id, selectedReaction, next),
    },
    chips: {
      onToggle: (emoji: string) => {
        const option = reactionOptionFromEmoji(emoji);
        if (!option) return;
        onReactionChange(message.id, selectedReaction, selectedReaction === option ? null : option);
      },
    },
  };
}

function userMessageCopyText(message: OrchestrationMessage) {
  return (
    message.text ||
    message.attachments?.map((attachment) => attachment.name).join(", ") ||
    "Attachment"
  );
}

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
              ? "text-amber-700 dark:text-amber-400"
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

interface AssistantMessageRowProps {
  readonly message: OrchestrationMessage;
  /** The replying bot, or null when it is no longer available. */
  readonly author: Pick<Bot, "avatar" | "name"> | null;
  readonly testId: string;
  /** First reply in a run from the same author: shows the avatar and name. */
  readonly startsGroup: boolean;
  readonly cwd: string | undefined;
  readonly threadRef: ScopedThreadRef | undefined;
  readonly stepMeter: BotStepMeterData | undefined;
  readonly pluginResults: ReadonlyArray<PluginResultEntry> | undefined;
  readonly currentPersonId: string | null | undefined;
  readonly playback: ReplyPlaybackSession | null;
  /** Changes when the playback context changes, so the read-aloud action is recomputed. */
  readonly playbackKey: string | null | undefined;
  readonly channelApproval: ChannelApprovalTarget | null;
  readonly onReply: MessageReplyHandler;
  /** Null while the chat has no linked thread to react in. */
  readonly onReactionChange: MessageReactionHandler | null;
}

/**
 * One assistant reply. Memoized with prop comparison that looks inside derived per-turn
 * objects, because those are rebuilt whenever any thread activity arrives.
 */
export const AssistantMessageRow = memo(function AssistantMessageRow({
  message,
  author,
  testId,
  startsGroup,
  cwd,
  threadRef,
  stepMeter,
  pluginResults,
  currentPersonId,
  playback,
  channelApproval,
  onReply,
  onReactionChange,
}: AssistantMessageRowProps) {
  const { t } = useI18n();
  const readAloud = replyPlaybackControlProps(playback, message);
  const copyText = message.text || "Attachment";
  const label = author?.name ?? t("Unavailable bot");
  const markdown = (
    <ChatMarkdown className="mt-1" cwd={cwd} text={message.text} threadRef={threadRef} />
  );
  if (!author) {
    return (
      <div
        className={`group/message mt-3 max-w-[85%] first:mt-0 ${ROW_VISIBILITY_CLASS}`}
        data-testid={testId}
      >
        <div className="text-sm font-medium">{label}</div>
        {markdown}
        <div className={`mt-0.5 flex ${HOVER_CONTROLS_CLASS}`}>
          <MessageControls
            copyText={copyText}
            {...(readAloud ? { readAloud } : {})}
            onReply={() => onReply(message.id, label, copyText)}
          />
        </div>
      </div>
    );
  }
  const selectedReaction = selectedReactionForPerson(message.reactions, currentPersonId);
  const reactions = reactionProps(message, selectedReaction, onReactionChange);
  return (
    <div
      className={cn(
        "group/message flex items-start gap-3",
        startsGroup ? "mt-3 first:mt-0" : "mt-1",
        ROW_VISIBILITY_CLASS,
      )}
      data-testid={testId}
    >
      {startsGroup ? (
        <BotAvatarView
          avatar={author.avatar}
          name={author.name}
          className="mt-0.5 size-7 shrink-0"
        />
      ) : (
        <div aria-hidden="true" className="size-7 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        {startsGroup ? <div className="text-sm font-medium">{author.name}</div> : null}
        <BotStepMeter meter={stepMeter} />
        {markdown}
        {pluginResults?.map(({ id, result }) => (
          <PluginSearchResultCard className="mt-3" key={id} result={result} />
        ))}
        <div className={`mt-0.5 flex ${HOVER_CONTROLS_CLASS}`}>
          <MessageControls
            copyText={copyText}
            {...(readAloud ? { readAloud } : {})}
            selectedReaction={selectedReaction}
            onReply={() => onReply(message.id, label, copyText)}
            {...reactions.controls}
          />
          {!onReactionChange ? (
            <UnavailableReactionControl selectedReaction={selectedReaction} />
          ) : null}
        </div>
        <MessageReactions
          reactions={message.reactions ?? []}
          selectedEmoji={selectedReaction}
          {...reactions.chips}
        />
        {channelApproval ? (
          <ChannelSendApproval
            environmentId={channelApproval.environmentId}
            botId={channelApproval.botId}
            origin={channelApproval.origin}
            threadId={channelApproval.threadId}
            messageId={message.id}
            delivery={message.channelDelivery}
            sent={channelApproval.sent}
            canSend={channelApproval.canSend}
          />
        ) : null}
      </div>
    </div>
  );
}, assistantRowPropsEqual);

function shallowEqual<T extends object>(a: T | null | undefined, b: T | null | undefined) {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a) as (keyof T)[];
  return keys.length === Object.keys(b).length && keys.every((key) => Object.is(a[key], b[key]));
}

function stepMetersEqual(a: BotStepMeterData | undefined, b: BotStepMeterData | undefined) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.tokens === b.tokens &&
    a.costUsd === b.costUsd &&
    a.hardStopReached === b.hardStopReached &&
    shallowEqual(a.engine, b.engine)
  );
}

function pluginResultsEqual(
  a: ReadonlyArray<PluginResultEntry> | undefined,
  b: ReadonlyArray<PluginResultEntry> | undefined,
) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((entry, index) => entry.id === b[index]?.id && entry.result === b[index]?.result);
}

export function assistantRowPropsEqual(
  previous: AssistantMessageRowProps,
  next: AssistantMessageRowProps,
) {
  const keys = Object.keys(next) as (keyof AssistantMessageRowProps)[];
  if (keys.length !== Object.keys(previous).length) return false;
  return keys.every((key) => {
    switch (key) {
      case "stepMeter":
        return stepMetersEqual(previous.stepMeter, next.stepMeter);
      case "pluginResults":
        return pluginResultsEqual(previous.pluginResults, next.pluginResults);
      case "channelApproval":
        return shallowEqual(previous.channelApproval, next.channelApproval);
      default:
        return Object.is(previous[key], next[key]);
    }
  });
}

/** One message from a person. `replyLabel` names the author in reply previews. */
export const UserMessageRow = memo(function UserMessageRow({
  message,
  testId,
  startsGroup,
  replyLabel,
  showChannelOrigin,
  skills,
  environmentId,
  currentPersonId,
  onReply,
  onReactionChange,
}: {
  readonly message: OrchestrationMessage;
  readonly testId: string;
  readonly startsGroup: boolean;
  readonly replyLabel: string;
  readonly showChannelOrigin: boolean;
  /** Provider skills whose `$name` tokens render as skill chips. */
  readonly skills: ReadonlyArray<ServerProviderSkill> | undefined;
  readonly environmentId: EnvironmentId | null;
  readonly currentPersonId: string | null | undefined;
  readonly onReply: MessageReplyHandler;
  /** Null while the chat has no linked thread to react in. */
  readonly onReactionChange: MessageReactionHandler | null;
}) {
  const copyText = userMessageCopyText(message);
  const selectedReaction = selectedReactionForPerson(message.reactions, currentPersonId);
  const reactions = reactionProps(message, selectedReaction, onReactionChange);
  return (
    <div
      className={cn(
        "group/message flex items-end justify-end gap-1",
        startsGroup ? "mt-3 first:mt-0" : "mt-1",
        ROW_VISIBILITY_CLASS,
      )}
      data-testid={testId}
    >
      <div className={`flex ${HOVER_CONTROLS_CLASS}`}>
        <MessageControls
          align="end"
          copyText={copyText}
          selectedReaction={selectedReaction}
          onReply={() => onReply(message.id, replyLabel, copyText)}
          {...reactions.controls}
        />
        {!onReactionChange ? (
          <UnavailableReactionControl selectedReaction={selectedReaction} />
        ) : null}
      </div>
      <div className="flex max-w-[78%] flex-col items-end">
        <div className="w-full rounded-2xl bg-foreground/10 px-3.5 py-2 text-sm leading-6">
          {showChannelOrigin && message.channelOrigin ? (
            <div className="mb-1 text-xs font-medium text-muted-foreground">
              {channelOriginLabel(message.channelOrigin, message.authorDisplayName)}
            </div>
          ) : null}
          {message.text ? <SentMessageText text={message.text} skills={skills} /> : null}
          {message.attachments?.length ? (
            <div className={message.text ? "mt-2" : undefined}>
              <BotMessageAttachments
                attachments={message.attachments}
                environmentId={environmentId ?? NO_ENVIRONMENT}
              />
            </div>
          ) : null}
        </div>
        <MessageReactions
          align="end"
          reactions={message.reactions ?? []}
          selectedEmoji={selectedReaction}
          {...reactions.chips}
        />
      </div>
    </div>
  );
});
