import { Match } from "effect";
import { ThreadTurnFoldRow } from "./thread-turn-fold-row";
import type { ThreadSilentRun } from "@akeru/client-runtime/silent-run";
import { useMobileI18n } from "../../lib/i18n";
import type { BotId, EnvironmentId, TurnId } from "@akeru/contracts";
import {
  channelDeliveryLabel,
  channelOriginLabel,
} from "@akeru/client-runtime/channel-origin-presentation";
import { stabilizeStreamingMarkdown } from "@akeru/client-runtime/markdown-streaming";
import { formatElapsed } from "@akeru/shared/orchestrationTiming";
import { formatTokens, formatUsd } from "@akeru/shared/usageFormat";
import { memo, useEffect, useState } from "react";
import { Markdown } from "react-native-nitro-markdown";
import { Platform, Text as NativeText, type ColorValue, View } from "react-native";
import Animated, { FadeIn, FadeInUp } from "react-native-reanimated";
import { hasWideMarkdownBlock } from "../../lib/wideMarkdownBlocks";
import {
  hasNativeSelectableMarkdownText,
  SelectableMarkdownText,
  type MarkdownImageRenderer,
  type SelectableMarkdownSkill,
} from "../../native/SelectableMarkdownText";
import { labelSentMessageMentions, useSentMessageMentions } from "./sentMessageMentions";
import { AppText as Text } from "../../components/AppText";
import { BotAvatarView, seededBlobAvatar } from "../../components/BotAvatarView";
import { ThreadDelegationFeedCard } from "./ThreadDelegationFeedCard";
import type { OrchestrationBot } from "@akeru/contracts";
import { CopyTextButton } from "../../components/CopyTextButton";
import { ReplyPlaybackControls } from "../replyPlayback/ReplyPlaybackControls";
import { replyPlaybackControlProps } from "../replyPlayback/useReplyPlaybackThread";
import { useOptionalReplyPlayback } from "../replyPlayback/ReplyPlaybackProvider";
import { cn } from "../../lib/cn";
import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { formatBotStepEngine, type BotStepMeterData } from "@akeru/client-runtime/bot-step-usage";
import { ThreadWorkGroupToggle, ThreadWorkLog } from "./thread-work-log";
import { MessageAttachmentFile, MessageAttachmentImage } from "./thread-feed-images";
import type { MarkdownStyleSet, MarkdownStyleSets } from "./thread-feed-markdown";

const WIDE_MARKDOWN_BLOCK_OPTIONS = {
  includeOrderedLists: Platform.OS === "android",
} as const;

const MESSAGE_TIME_OPTIONS: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };

/** Message clock time in the interface language; `formatDate` comes from `useMobileI18n`. */
function formatMessageTime(
  input: string,
  formatDate: (value: number, options: Intl.DateTimeFormatOptions) => string,
): string {
  const timestamp = Date.parse(input);

  if (Number.isNaN(timestamp)) {
    return "";
  }

  return formatDate(timestamp, MESSAGE_TIME_OPTIONS);
}

// Entering animations must only play for rows born just now — LegendList
// remounts rows when they scroll back into view, and replaying an entrance for
// old content would be its own kind of jank.
const FRESH_ENTRY_WINDOW_MS = 3_000;

function isFreshTimestamp(input: string): boolean {
  const timestamp = Date.parse(input);

  return Number.isFinite(timestamp) && Date.now() - timestamp < FRESH_ENTRY_WINDOW_MS;
}

/** Everything a feed row needs from the screen; built once per render by ThreadFeed. */
type ThreadFeedRenderContext = {
  readonly environmentId: EnvironmentId;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill>;
  readonly silentRun?: ThreadSilentRun | null;
  readonly botsById?: ReadonlyMap<string, OrchestrationBot>;
  readonly copiedRowId: string | null;
  readonly expandedWorkRows: Record<string, boolean>;
  readonly terminalAssistantMessageIds: ReadonlySet<string>;
  /** Group chats only: the bot to name above a message where the speaker changes. */
  readonly speakerLabels: ReadonlyMap<string, BotId>;
  readonly unsettledTurnId: TurnId | null;
  readonly onCopyWorkRow: (rowId: string, value: string) => void;
  readonly onToggleWorkGroup: (groupId: string) => void;
  readonly onToggleWorkRow: (rowId: string) => void;
  readonly onToggleTurnFold: (turnId: TurnId) => void;
  readonly onPressImage: (uri: string, headers?: Record<string, string>) => void;
  readonly onMarkdownLinkPress: (href: string) => void;
  readonly renderMarkdownImage: MarkdownImageRenderer;
  readonly iconSubtleColor: ColorValue | undefined;
  readonly userBubbleColor: ColorValue | undefined;
  readonly markdownStyles: MarkdownStyleSets;
  readonly userBubbleMaxWidth: number;
  readonly replyPlayback: ReturnType<typeof useOptionalReplyPlayback>;
  readonly formatDate: (value: number, options: Intl.DateTimeFormatOptions) => string;
  readonly unknownBotLabel: string;
};

export function renderFeedEntry(
  info: { item: ThreadFeedEntry; index: number },
  props: ThreadFeedRenderContext,
) {
  const entry = info.item;
  const { markdownStyles, iconSubtleColor, userBubbleColor } = props;

  if (entry.type === "working") {
    return <WorkingTimelineRow startedAt={entry.createdAt} silentRun={props.silentRun ?? null} />;
  }

  if (entry.type === "turn-fold") {
    return (
      <ThreadTurnFoldRow
        entry={entry}
        onToggle={props.onToggleTurnFold}
        iconColor={iconSubtleColor}
      />
    );
  }

  if (entry.type === "work-toggle") {
    return (
      <ThreadWorkGroupToggle
        expanded={entry.expanded}
        hiddenCount={entry.hiddenCount}
        iconSubtleColor={iconSubtleColor}
        onlyToolActivities={entry.onlyToolActivities}
        onToggle={() => props.onToggleWorkGroup(entry.groupId)}
      />
    );
  }

  if (entry.type === "delegation") {
    const botsById = props.botsById;

    return (
      <ThreadDelegationFeedCard
        environmentId={props.environmentId}
        delegation={entry.delegation}
        actions={entry.actions}
        childBot={botsById?.get(entry.delegation.childBotId) ?? null}
        parentBot={botsById?.get(entry.delegation.parentBotId) ?? null}
      />
    );
  }

  if (entry.type === "message") {
    const { message } = entry;
    const isUser = message.role === "user";
    const styles = isUser ? markdownStyles.user : markdownStyles.assistant;

    const timestampLabel = formatMessageTime(
      isUser ? message.createdAt : message.updatedAt,
      props.formatDate,
    );

    const attachments = message.attachments ?? [];
    // A bubble that sizes itself from its content cannot lay out a block whose
    // intrinsic width overflows `maxWidth`: Android positions the bubble's
    // children during the unclamped pass and never moves them once the width
    // is clamped, so the paragraphs around the block end up drawn on top of
    // each other. Pinning the width removes that pass.
    const hasWideBlock = hasWideMarkdownBlock(message.text, WIDE_MARKDOWN_BLOCK_OPTIONS);

    const assistantTurnStillInProgress =
      message.role === "assistant" &&
      props.unsettledTurnId !== null &&
      message.turnId === props.unsettledTurnId;

    const showAssistantMeta =
      message.role === "assistant" &&
      props.terminalAssistantMessageIds.has(message.id) &&
      !assistantTurnStillInProgress &&
      !message.streaming;

    if (isUser) {
      const enterAnimated = isFreshTimestamp(message.createdAt);

      return (
        <Animated.View
          className="mb-5 items-end"
          {...(enterAnimated ? { entering: FadeInUp.duration(220) } : {})}
        >
          <View
            className="min-w-0 gap-2 rounded-[20px] px-3.5 py-2.5"
            style={{
              backgroundColor: userBubbleColor,
              maxWidth: props.userBubbleMaxWidth,
              ...(hasWideBlock ? { width: props.userBubbleMaxWidth } : null),
            }}
          >
            {message.channelOrigin ? (
              <NativeText className="font-t3-medium text-[11px] text-channel-detail">
                {channelOriginLabel(message.channelOrigin, message.authorDisplayName)}
              </NativeText>
            ) : null}
            {message.text.trim().length > 0 ? (
              <UserMessageContent
                text={message.text}
                markdownStyles={styles}
                skills={props.skills}
                onLinkPress={props.onMarkdownLinkPress}
                renderImage={props.renderMarkdownImage}
              />
            ) : null}
            {attachments.map((attachment) => {
              return attachment.type === "file" ? (
                <MessageAttachmentFile
                  key={attachment.id}
                  environmentId={props.environmentId}
                  attachmentId={attachment.id}
                  name={attachment.name}
                />
              ) : (
                <MessageAttachmentImage
                  key={attachment.id}
                  environmentId={props.environmentId}
                  attachmentId={attachment.id}
                  className="aspect-[1.3] w-full rounded-[14px] bg-white/15"
                  onPressImage={props.onPressImage}
                />
              );
            })}
          </View>
          <View className="mt-1 flex-row items-center justify-end gap-1 pr-0.5">
            <Text className="font-t3-medium text-xs tabular-nums text-neutral-600 dark:text-neutral-400">
              {timestampLabel}
            </Text>
            {message.text.trim().length > 0 ? (
              <CopyTextButton
                accessibilityLabel="Copy message"
                text={message.text}
                tintColor={iconSubtleColor}
                buttonSize={28}
                iconSize={13}
              />
            ) : null}
          </View>
        </Animated.View>
      );
    }

    // Skip empty assistant messages (no text, no attachments) — they would
    // render as an orphaned timestamp and break adjacent activity-group merging.
    if (message.text.trim().length === 0 && attachments.length === 0) {
      return null;
    }

    const enterAnimated = isFreshTimestamp(message.createdAt);
    const speakerBotId = props.speakerLabels.get(message.id) ?? null;
    const speakerBot = speakerBotId ? props.botsById?.get(speakerBotId) : undefined;

    const assistantMarkdown = message.streaming
      ? stabilizeStreamingMarkdown(message.text)
      : message.text;

    return (
      <Animated.View
        className={cn(showAssistantMeta ? "mb-5 px-1" : "mb-2 px-1")}
        {...(enterAnimated ? { entering: FadeIn.duration(220) } : {})}
      >
        {speakerBotId ? (
          <View className="mb-1.5 flex-row items-center gap-2">
            <BotAvatarView
              avatar={speakerBot?.avatar ?? seededBlobAvatar(speakerBotId)}
              size={20}
            />
            <Text className="font-t3-medium text-sm text-foreground" numberOfLines={1}>
              {speakerBot?.name ?? props.unknownBotLabel}
            </Text>
          </View>
        ) : null}
        {entry.botStepMeter ? <BotStepMeter meter={entry.botStepMeter} /> : null}
        {message.text.trim().length > 0 ? (
          hasNativeSelectableMarkdownText() ? (
            <SelectableMarkdownText
              markdown={assistantMarkdown}
              skills={props.skills}
              textStyle={styles.nativeTextStyle}
              onLinkPress={props.onMarkdownLinkPress}
              renderImage={props.renderMarkdownImage}
            />
          ) : (
            <Markdown
              options={{ gfm: true }}
              renderers={styles.renderers}
              styles={styles.styles}
              theme={styles.theme}
            >
              {assistantMarkdown}
            </Markdown>
          )
        ) : null}
        {attachments.map((attachment) => {
          return attachment.type === "file" ? (
            <MessageAttachmentFile
              key={attachment.id}
              environmentId={props.environmentId}
              attachmentId={attachment.id}
              name={attachment.name}
            />
          ) : (
            <MessageAttachmentImage
              key={attachment.id}
              environmentId={props.environmentId}
              attachmentId={attachment.id}
              className="mt-1.5 aspect-[1.3] w-full rounded-[18px] bg-neutral-200 dark:bg-neutral-800"
              onPressImage={props.onPressImage}
            />
          );
        })}
        {message.channelDelivery
          ? (() => {
              const delivery = channelDeliveryLabel(message.channelDelivery, entry.channelProvider);

              return delivery ? (
                <NativeText
                  className={cn(
                    "mt-1 text-[11px]",
                    Match.value(delivery.tone).pipe(
                      Match.when("error", () => "text-red-600 dark:text-red-400"),
                      Match.when("warning", () => "text-amber-700 dark:text-amber-400"),
                      Match.orElse(() => "text-neutral-600 dark:text-neutral-400"),
                    ),
                  )}
                >
                  {delivery.message}
                </NativeText>
              ) : null;
            })()
          : null}
        {showAssistantMeta ? (
          <View className="mt-1 gap-1">
            <View className="flex-row flex-wrap items-center gap-1">
              <CopyTextButton
                accessibilityLabel="Copy message"
                text={message.text}
                tintColor={iconSubtleColor}
                buttonSize={28}
                iconSize={13}
              />
              <Text className="font-t3-medium text-xs tabular-nums text-neutral-600 dark:text-neutral-400">
                {timestampLabel}
              </Text>
            </View>
            {(() => {
              const readAloud = replyPlaybackControlProps(props.replyPlayback, message);

              return readAloud ? <ReplyPlaybackControls {...readAloud} /> : null;
            })()}
          </View>
        ) : null}
      </Animated.View>
    );
  }

  return (
    <ThreadWorkLog
      activities={entry.activities}
      copiedRowId={props.copiedRowId}
      expandedRows={props.expandedWorkRows}
      iconSubtleColor={iconSubtleColor}
      onCopyRow={props.onCopyWorkRow}
      onToggleRow={props.onToggleWorkRow}
    />
  );
}

function BotStepMeter(props: { readonly meter: BotStepMeterData }) {
  const label = `${formatBotStepEngine(props.meter.engine)} · ${
    props.meter.tokens === null ? "—" : formatTokens(props.meter.tokens)
  } tokens · ${props.meter.costUsd === null ? "$—" : formatUsd(props.meter.costUsd)}`;

  return (
    <Text
      accessibilityLabel={label}
      className="mb-1 font-mono text-xs tabular-nums text-foreground-muted"
      numberOfLines={1}
    >
      {label}
    </Text>
  );
}

const WorkingTimelineRow = memo(function WorkingTimelineRow(props: {
  readonly startedAt: string;
  readonly silentRun: ThreadSilentRun | null;
}) {
  const { t } = useMobileI18n();
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const intervalId = setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);

    return () => clearInterval(intervalId);
  }, [props.startedAt]);

  // A silent run counts from the last output, so the duration is how long it has been quiet.
  const durationLabel =
    formatElapsed(
      props.silentRun?.lastActivityAt ?? props.startedAt,
      new Date(nowMs).toISOString(),
    ) ?? "0s";

  return (
    <View className="mb-4 flex-row items-center gap-2 px-1.5 py-1">
      <View className="flex-row items-center gap-1">
        <View className="h-1 w-1 rounded-full bg-neutral-400 dark:bg-neutral-500" />
        <View className="h-1 w-1 rounded-full bg-neutral-400/80 dark:bg-neutral-500/80" />
        <View className="h-1 w-1 rounded-full bg-neutral-400/60 dark:bg-neutral-500/60" />
      </View>
      <Text className="font-t3-medium text-xs tabular-nums text-neutral-600 dark:text-neutral-400">
        {props.silentRun
          ? t("No response from {provider} for {duration}", {
              provider: props.silentRun.providerName,
              duration: durationLabel,
            })
          : t("Working for {duration}", { duration: durationLabel })}
      </Text>
    </View>
  );
});

function UserMessageContent(props: {
  readonly text: string;
  readonly markdownStyles: MarkdownStyleSet;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill>;
  readonly onLinkPress: (href: string) => void;
  readonly renderImage: MarkdownImageRenderer;
}) {
  const mentions = useSentMessageMentions(props.text, props.skills);

  if (hasNativeSelectableMarkdownText()) {
    return (
      <SelectableMarkdownText
        markdown={props.text}
        skills={mentions.skills}
        textStyle={props.markdownStyles.nativeTextStyle}
        preserveSoftBreaks
        onLinkPress={props.onLinkPress}
        renderImage={props.renderImage}
      />
    );
  }

  return (
    <Markdown
      options={{ gfm: true }}
      renderers={props.markdownStyles.renderers}
      styles={props.markdownStyles.styles}
      theme={props.markdownStyles.theme}
    >
      {labelSentMessageMentions(props.text, mentions.displays)}
    </Markdown>
  );
}

export function ThreadFeedPlaceholder(props: {
  readonly bottomInset: number;
  readonly detail: string;
  readonly horizontalPadding: number;
  readonly title: string;
  readonly topInset: number;
}) {
  return (
    <View
      style={{
        flex: 1,
        flexGrow: 1,
        alignItems: "center",
        justifyContent: "center",
        paddingTop: props.topInset,
        paddingBottom: props.bottomInset,
        paddingHorizontal: props.horizontalPadding + 24,
      }}
    >
      <View className="max-w-[320px] items-center gap-2">
        <Text className="text-center font-t3-bold text-lg text-foreground">{props.title}</Text>
        <Text className="text-center text-sm leading-normal text-foreground-secondary">
          {props.detail}
        </Text>
      </View>
    </View>
  );
}
