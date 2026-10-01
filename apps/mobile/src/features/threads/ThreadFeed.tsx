import type { ThreadSilentRun } from "@akeru/client-runtime/silent-run";
import { useMobileI18n } from "../../lib/i18n";
import * as Haptics from "expo-haptics";
import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import type { LegendListRef } from "@legendapp/list/react-native";
import type { BotId, EnvironmentId, MessageId, ThreadId, TurnId } from "@akeru/contracts";
import { classifyMarkdownImageSource } from "@akeru/client-runtime/markdown-images";
import { CHAT_LIST_ANCHOR_OFFSET, resolveChatListAnchoredEndSpace } from "@akeru/shared/chatList";
import { HeaderHeightContext } from "@react-navigation/elements";
import { useNavigation } from "@react-navigation/native";
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  Platform,
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import ImageViewing from "react-native-image-viewing";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { SharedValue } from "react-native-reanimated";
import { useThemeColor } from "../../lib/useThemeColor";
import { IOS_NAV_BAR_HEIGHT } from "../../lib/layoutMetrics";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import type {
  MarkdownImageRenderer,
  SelectableMarkdownSkill,
} from "../../native/SelectableMarkdownText";
import { AppText as Text } from "../../components/AppText";
import type { OrchestrationBot } from "@akeru/contracts";
import { useReplyPlaybackThread } from "../replyPlayback/useReplyPlaybackThread";
import { useOptionalReplyPlayback } from "../replyPlayback/ReplyPlaybackProvider";
import { useEnvironmentPresentation } from "../../state/presentation";
import {
  deriveCenteredContentHorizontalPadding,
  deriveThreadFeedInitialContentInset,
  type LayoutVariant,
} from "../../lib/layout";
import { scaledTypographyLineHeight } from "../../lib/appearancePreferences";
import { MOBILE_TYPOGRAPHY } from "../../lib/typography";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { resolveMarkdownLinkPresentation } from "@akeru/mobile-markdown-text/links";
import {
  deriveGroupSpeakerLabels,
  deriveThreadFeedPresentation,
  threadFeedEntriesEqual,
  type ThreadFeedEntry,
  type ThreadFeedLatestTurn,
} from "../../lib/threadActivity";
import type { ThreadContentPresentation } from "./threadContentPresentation";
import { ThreadChannels } from "./ThreadChannels";
import { collapsedWorkLogHeight, WORK_GROUP_TOGGLE_HEIGHT } from "./thread-work-log";
import { isAppDeepLink } from "@akeru/client-runtime/settings-deep-link";
import { resolveMobileSettingsDestination } from "../settings/settingsDeepLink";
import {
  ThreadMarkdownImage,
  ThreadMarkdownImageUnavailable,
  ThreadMarkdownImageView,
} from "./thread-feed-images";
import { useMarkdownStyles } from "./thread-feed-markdown";
import { ThreadFeedPlaceholder, renderFeedEntry } from "./thread-feed-rows";
import { useThreadFeedFollow } from "./use-thread-feed-follow";

// Pre-measurement heights for getFixedItemSize, mirroring renderFeedEntry's
// classNames. The fold row's min-h-11 (44px) stays taller than its single
// text-sm line at every supported base font size (26px at the 22pt maximum),
// so its height is a constant; a drifted value costs one correction on
// measure, not a persistent offset.
const TURN_FOLD_HEIGHT = 56; // min-h-11 (44) + mb-3 (12)

// The working row has no min-height clamp — its height follows the scaled
// text-xs line height (see workingRowHeight in ThreadFeed).
const WORKING_ROW_VERTICAL_EXTRAS = 24; // py-1 (8) + mb-4 (16)

export interface ThreadFeedProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly botId: BotId | null;
  readonly workspaceRoot?: string | null;
  readonly feed: ReadonlyArray<ThreadFeedEntry>;
  /** Bots by id, so delegation cards can show the child bot's name and avatar. */
  readonly botsById?: ReadonlyMap<string, OrchestrationBot>;
  /** Set in group chats: assistant messages without a responding bot belong to the boss, if any. */
  readonly speakerGroup?: { readonly bossBotId: BotId | null } | null;
  readonly contentPresentation: ThreadContentPresentation;
  readonly agentLabel: string;
  readonly latestTurn: ThreadFeedLatestTurn | null;
  readonly activeWorkStartedAt: string | null;
  /** The running turn's provider went quiet; the working row says so instead. */
  readonly silentRun?: ThreadSilentRun | null;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly freeze: SharedValue<boolean>;
  readonly anchorMessageId: MessageId | null;
  readonly submittedMessageId: MessageId | null;
  readonly contentInsetEndAdjustment: SharedValue<number>;
  readonly contentTopInset?: number;
  readonly contentBottomInset?: number;
  readonly contentMaxWidth?: number;
  readonly layoutVariant?: LayoutVariant;
  readonly usesAutomaticContentInsets?: boolean;
  readonly onHeaderMaterialVisibilityChange?: (visible: boolean) => void;
  readonly onEndFollowEnabledChange?: (enabled: boolean) => void;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill>;
  /** Non-null when older turns exist beyond the loaded window. */
  readonly loadEarlier?: {
    readonly loading: boolean;
    readonly onLoadEarlier: () => void;
  } | null;
}

const threadFeedKeyExtractor = (entry: ThreadFeedEntry) => entry.id;

const threadFeedItemType = (entry: ThreadFeedEntry) =>
  entry.type === "message" ? `message:${entry.message.role}` : entry.type;

type PlaybackMessage = Extract<ThreadFeedEntry, { type: "message" }>["message"];

function sameMessages(
  left: ReadonlyArray<PlaybackMessage>,
  right: ReadonlyArray<PlaybackMessage>,
): boolean {
  return left.length === right.length && left.every((message, index) => message === right[index]);
}

function sameIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;

  for (const id of left) {
    if (!right.has(id)) return false;
  }

  return true;
}

export const ThreadFeed = memo(function ThreadFeed(props: ThreadFeedProps) {
  const { t, formatDate } = useMobileI18n();
  const navigation = useNavigation();
  const replyPlayback = useOptionalReplyPlayback();
  const environment = useEnvironmentPresentation(props.environmentId);
  // Activity-only feed updates keep the previous array so reply playback does not re-observe.
  const playbackMessagesRef = useRef<ReadonlyArray<PlaybackMessage>>([]);

  const playbackMessages = useMemo(() => {
    const next = props.feed.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));

    if (sameMessages(playbackMessagesRef.current, next)) return playbackMessagesRef.current;
    playbackMessagesRef.current = next;

    return next;
  }, [props.feed]);

  const replySynthesis = useReplyPlaybackThread({
    environmentId: props.environmentId,
    threadId: props.threadId,
    messages: playbackMessages,
    connected: environment.presentation?.connection.phase === "connected",
  });

  const copyFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousLatestTurnRef = useRef(props.latestTurn);
  const { width: windowWidth } = useWindowDimensions();
  const { appearance } = useAppearancePreferences();

  const [viewportWidth, setViewportWidth] = useState(() =>
    props.layoutVariant === "split" ? 0 : windowWidth,
  );

  const [viewportHeight, setViewportHeight] = useState(0);

  const [interactionState, setInteractionState] = useState<{
    readonly copiedRowId: string | null;
    readonly expandedWorkGroups: Record<string, boolean>;
    readonly expandedWorkRows: Record<string, boolean>;
    readonly expandedTurnIds: ReadonlySet<TurnId>;
  }>({
    copiedRowId: null,
    expandedWorkGroups: {},
    expandedWorkRows: {},
    expandedTurnIds: new Set(),
  });

  const { copiedRowId, expandedWorkGroups, expandedWorkRows, expandedTurnIds } = interactionState;

  const [expandedImage, setExpandedImage] = useState<{
    uri: string;
    headers?: Record<string, string>;
  } | null>(null);

  const horizontalPadding = props.layoutVariant === "split" ? 20 : 16;

  const contentHorizontalPadding = deriveCenteredContentHorizontalPadding({
    viewportWidth,
    maxContentWidth: props.contentMaxWidth ?? null,
    minimumPadding: horizontalPadding,
  });

  const contentWidth = Math.max(0, viewportWidth - contentHorizontalPadding * 2);
  const userBubbleMaxWidth = contentWidth * 0.85;
  const insets = useSafeAreaInsets();
  const topContentInset = props.contentTopInset ?? insets.top + IOS_NAV_BAR_HEIGHT;
  const bottomContentInset = props.contentBottomInset ?? 18;

  const usesNativeAutomaticInsets =
    props.usesAutomaticContentInsets === true && Platform.OS === "ios";

  const initialContentInset = deriveThreadFeedInitialContentInset({
    platform: Platform.OS,
    usesNativeAutomaticInsets,
    bottomContentInset,
  });

  // With automatic insets the header inset lives in UIKit's adjustedContentInset,
  // which LegendList's JS anchoring math cannot see — it measures the anchored
  // end space from the scroll view's frame top. Fold the header height back into
  // the anchor offset or a just-sent message anchors underneath the header and
  // the oversized end space keeps maintainScrollAtEnd snapping away from earlier
  // messages. Read the context directly (useHeaderHeight throws outside a
  // header-providing screen) and fall back to the standard iOS bar height.
  const navigationHeaderHeight = useContext(HeaderHeightContext);

  const anchorTopInset = usesNativeAutomaticInsets
    ? navigationHeaderHeight || insets.top + IOS_NAV_BAR_HEIGHT
    : topContentInset;

  const iconSubtleColor = useThemeColor("--color-icon-subtle");
  const userBubbleColor = useThemeColor("--color-user-bubble");

  const onMarkdownLinkPress = useCallback(
    (href: string) => {
      if (isAppDeepLink(href)) {
        const destination = resolveMobileSettingsDestination(href);

        if (destination === null) return;
        void Haptics.selectionAsync();

        if (destination.kind === "health") {
          navigation.navigate("SettingsSheet", {
            screen: "SettingsContent",
            params: {
              screen: "SettingsProviderHealth",
              params: {
                environmentId: props.environmentId,
                target: destination.target,
              },
            },
          });
        } else {
          navigation.navigate("SettingsSheet", {
            screen: "SettingsContent",
            params: { screen: destination.kind === "home" ? "Settings" : destination.screen },
          });
        }

        return;
      }

      const presentation = resolveMarkdownLinkPresentation(href);

      // Mobile has no workspace file viewer; file links stay inert.
      if (presentation.kind === "file") return;

      if (presentation.href) {
        void tryOpenExternalUrl(presentation.href, "markdown-link");
      }
    },
    [props.environmentId, navigation],
  );

  const renderMarkdownImage = useCallback<MarkdownImageRenderer>(
    (image) => {
      const imageSource = classifyMarkdownImageSource(image.href, props.workspaceRoot ?? null);

      if (imageSource._tag === "Direct") {
        return (
          <ThreadMarkdownImageView
            uri={imageSource.uri}
            sourceKey={imageSource.uri}
            unavailable={false}
            alt={image.alt}
            onPressImage={(uri) => setExpandedImage({ uri })}
          />
        );
      }

      if (imageSource._tag === "Blocked") {
        return <ThreadMarkdownImageUnavailable alt={image.alt} />;
      }

      return (
        <ThreadMarkdownImage
          environmentId={props.environmentId}
          threadId={props.threadId}
          path={imageSource.path}
          alt={image.alt}
          onPressImage={(uri) => setExpandedImage({ uri })}
        />
      );
    },
    [props.environmentId, props.threadId, props.workspaceRoot],
  );

  const markdownStyles = useMarkdownStyles(onMarkdownLinkPress, renderMarkdownImage);

  // Thread identity is env-scoped: two environments can hold the same
  // ThreadId, and keying resets (or the list mount) on the bare id would
  // carry stale scroll/follow state across an environment switch.
  const feedThreadKey = scopedThreadKey(props.environmentId, props.threadId);

  const {
    endScrollMaintenanceActive,
    maintainVisibleContentPosition,
    suspendEndScrollMaintenanceForDisclosure,
    scrollHandlers,
  } = useThreadFeedFollow({
    listRef: props.listRef,
    anchorTopInset,
    feedThreadKey,
    submittedMessageId: props.submittedMessageId,
    onEndFollowEnabledChange: props.onEndFollowEnabledChange,
    onHeaderMaterialVisibilityChange: props.onHeaderMaterialVisibilityChange,
  });

  const handleViewportLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = Math.round(event.nativeEvent.layout.width);
    const nextHeight = Math.round(event.nativeEvent.layout.height);
    setViewportWidth((current) => (Math.abs(current - nextWidth) > 1 ? nextWidth : current));
    setViewportHeight((current) => (Math.abs(current - nextHeight) > 1 ? nextHeight : current));
  }, []);

  const expandedWorkGroupIds = useMemo(() => {
    const ids = new Set<string>();

    for (const [groupId, expanded] of Object.entries(expandedWorkGroups)) {
      if (expanded) {
        ids.add(groupId);
      }
    }

    return ids;
  }, [expandedWorkGroups]);

  const presentedFeed = useMemo(
    () =>
      deriveThreadFeedPresentation(
        props.feed,
        props.latestTurn,
        expandedTurnIds,
        expandedWorkGroupIds,
        props.activeWorkStartedAt,
      ),
    [
      expandedTurnIds,
      expandedWorkGroupIds,
      props.activeWorkStartedAt,
      props.feed,
      props.latestTurn,
    ],
  );

  // The empty↔filled key below remounts the list, which resets its imperative
  // content-inset override — and useKeyboardChatComposerInset (mounted above
  // the remount boundary) deduplicates by height, so it never re-reports the
  // composer inset to the fresh instance. Re-report the measured overlay height
  // (composer plus any pending approval / user-input card) so the remounted
  // list's scroll math gets the true value; on Android the declarative
  // contentInset floor below covers the window before this effect lands.
  const listMountKey = `${feedThreadKey}:${props.feed.length === 0 ? "empty" : "filled"}`;
  useLayoutEffect(() => {
    const bottom = props.contentInsetEndAdjustment.value;

    if (bottom > 0) {
      props.listRef.current?.reportContentInset({ bottom });
    }
  }, [listMountKey, props.contentInsetEndAdjustment, props.listRef]);

  const anchoredEndSpace = useMemo(
    () =>
      resolveChatListAnchoredEndSpace(
        presentedFeed,
        props.anchorMessageId,
        (entry) => (entry.type === "message" && entry.message.role === "user" ? entry.id : null),
        { anchorOffset: anchorTopInset + CHAT_LIST_ANCHOR_OFFSET },
      ),
    [presentedFeed, props.anchorMessageId, anchorTopInset],
  );

  // Kept identity-stable while streaming: it is row render context, and a new Set would
  // repaint every visible row on each delta.
  const terminalAssistantMessageIdsRef = useRef<ReadonlySet<string>>(new Set());

  const terminalAssistantMessageIds = useMemo(() => {
    const terminalIdsByTurn = new Map<TurnId, string>();

    for (const entry of props.feed) {
      if (entry.type === "message" && entry.message.role === "assistant" && entry.message.turnId) {
        terminalIdsByTurn.set(entry.message.turnId, entry.message.id);
      }
    }

    const next = new Set(terminalIdsByTurn.values());

    if (sameIds(terminalAssistantMessageIdsRef.current, next)) {
      return terminalAssistantMessageIdsRef.current;
    }

    terminalAssistantMessageIdsRef.current = next;

    return next;
  }, [props.feed]);

  const unsettledTurnId =
    props.latestTurn &&
    (props.latestTurn.completedAt === null || props.latestTurn.state === "running")
      ? props.latestTurn.turnId
      : null;

  const speakerLabels = useMemo(
    () => deriveGroupSpeakerLabels(presentedFeed, props.speakerGroup ?? null),
    [presentedFeed, props.speakerGroup],
  );

  useEffect(() => {
    const previous = previousLatestTurnRef.current;
    previousLatestTurnRef.current = props.latestTurn;

    if (!props.latestTurn || !previous) {
      return;
    }

    if (props.latestTurn.turnId === previous.turnId) {
      if (previous.state === "running" && props.latestTurn.state === "interrupted") {
        const interruptedTurnId = props.latestTurn.turnId;
        setInteractionState((current) => ({
          ...current,
          expandedTurnIds: new Set(current.expandedTurnIds).add(interruptedTurnId),
        }));
      }

      return;
    }

    setInteractionState((current) => {
      if (!current.expandedTurnIds.has(previous.turnId)) {
        return current;
      }

      const next = new Set(current.expandedTurnIds);
      next.delete(previous.turnId);

      return { ...current, expandedTurnIds: next };
    });
  }, [props.latestTurn]);

  useEffect(() => {
    return () => {
      if (copyFeedbackTimeoutRef.current) {
        clearTimeout(copyFeedbackTimeoutRef.current);
      }
    };
  }, []);

  const onCopyWorkRow = useCallback((rowId: string, value: string) => {
    copyTextWithHaptic(value, {
      target: "thread-work-row",
      feedback: "selection",
    });
    setInteractionState((current) => ({ ...current, copiedRowId: rowId }));

    if (copyFeedbackTimeoutRef.current) {
      clearTimeout(copyFeedbackTimeoutRef.current);
    }

    copyFeedbackTimeoutRef.current = setTimeout(() => {
      setInteractionState((current) =>
        current.copiedRowId === rowId ? { ...current, copiedRowId: null } : current,
      );
      copyFeedbackTimeoutRef.current = null;
    }, 1200);
  }, []);

  const onToggleWorkGroup = useCallback(
    (groupId: string) => {
      suspendEndScrollMaintenanceForDisclosure(`work-toggle:${groupId}`);
      setInteractionState((current) => ({
        ...current,
        expandedWorkGroups: {
          ...current.expandedWorkGroups,
          [groupId]: !(current.expandedWorkGroups[groupId] ?? false),
        },
      }));
    },
    [suspendEndScrollMaintenanceForDisclosure],
  );

  const onToggleWorkRow = useCallback(
    (rowId: string) => {
      suspendEndScrollMaintenanceForDisclosure(rowId);
      setInteractionState((current) => ({
        ...current,
        expandedWorkRows: {
          ...current.expandedWorkRows,
          [rowId]: !(current.expandedWorkRows[rowId] ?? false),
        },
      }));
    },
    [suspendEndScrollMaintenanceForDisclosure],
  );

  const onToggleTurnFold = useCallback(
    (turnId: TurnId) => {
      suspendEndScrollMaintenanceForDisclosure(`turn-fold:${turnId}`);
      setInteractionState((current) => {
        const next = new Set(current.expandedTurnIds);

        if (next.has(turnId)) {
          next.delete(turnId);
        } else {
          next.add(turnId);
        }

        return { ...current, expandedTurnIds: next };
      });
    },
    [suspendEndScrollMaintenanceForDisclosure],
  );

  const onPressImage = useCallback((uri: string, headers?: Record<string, string>) => {
    setExpandedImage({ uri, headers });
  }, []);

  // Rows whose height is known before they ever render. Without this, every
  // row above the viewport is assumed to be estimatedItemSize tall, and
  // scrolling up through unmeasured content corrects each row's height as it
  // mounts — the feed visibly jumps. Fixed sizes make the small chrome rows
  // exact; message rows stay undefined and use LegendList's per-type running
  // average once one of their type has been measured. Text-driven heights
  // follow the configurable base font size via scaledTypographyLineHeight.
  const workingRowHeight =
    WORKING_ROW_VERTICAL_EXTRAS +
    scaledTypographyLineHeight(MOBILE_TYPOGRAPHY.label, appearance.baseFontSize);

  const getFixedItemSize = useCallback(
    (entry: ThreadFeedEntry) => {
      switch (entry.type) {
        case "turn-fold":
          return TURN_FOLD_HEIGHT;
        case "work-toggle":
          return WORK_GROUP_TOGGLE_HEIGHT;
        case "working":
          return workingRowHeight;
        case "activity-group":
          // Expanded rows append a variable detail block — fall back to
          // measurement for those groups.
          return entry.activities.some((activity) => expandedWorkRows[activity.id])
            ? undefined
            : collapsedWorkLogHeight(entry.activities, appearance.baseFontSize);
        default:
          return undefined;
      }
    },
    [expandedWorkRows, workingRowHeight, appearance.baseFontSize],
  );

  // LegendList repaints visible rows only when their item or extraData changes, never for a
  // new renderItem closure. Everything rows read lives here and doubles as extraData.
  const feedRenderContext = useMemo(
    () => ({
      environmentId: props.environmentId,
      copiedRowId,
      expandedWorkRows,
      terminalAssistantMessageIds,
      speakerLabels,
      unsettledTurnId,
      onCopyWorkRow,
      onToggleWorkGroup,
      onToggleWorkRow,
      onToggleTurnFold,
      onPressImage,
      onMarkdownLinkPress,
      renderMarkdownImage,
      iconSubtleColor,
      userBubbleColor,
      markdownStyles,
      userBubbleMaxWidth,
      skills: props.skills,
      silentRun: props.silentRun,
      botsById: props.botsById,
      replyPlayback,
      replySynthesis,
      formatDate,
      unknownBotLabel: t("Unknown bot"),
    }),
    [
      formatDate,
      t,
      copiedRowId,
      expandedWorkRows,
      terminalAssistantMessageIds,
      speakerLabels,
      unsettledTurnId,
      iconSubtleColor,
      userBubbleColor,
      markdownStyles,
      userBubbleMaxWidth,
      onCopyWorkRow,
      onMarkdownLinkPress,
      onPressImage,
      onToggleTurnFold,
      onToggleWorkGroup,
      onToggleWorkRow,
      props.botsById,
      props.environmentId,
      props.skills,
      props.silentRun,
      renderMarkdownImage,
      replyPlayback,
      replySynthesis,
    ],
  );

  const renderItem = useCallback(
    (info: { item: ThreadFeedEntry; index: number }) => renderFeedEntry(info, feedRenderContext),
    [feedRenderContext],
  );

  const loadEarlier = props.loadEarlier;

  const listHeader = useMemo(
    () => (
      <>
        {usesNativeAutomaticInsets ? null : <View style={{ height: topContentInset }} />}
        <ThreadChannels environmentId={props.environmentId} botId={props.botId} />
        {loadEarlier != null ? (
          <Pressable
            onPress={loadEarlier.onLoadEarlier}
            disabled={loadEarlier.loading}
            className="items-center py-2"
          >
            <Text className="text-xs text-foreground-secondary">
              {loadEarlier.loading ? t("Loading earlier turns…") : t("Load earlier turns")}
            </Text>
          </Pressable>
        ) : null}
      </>
    ),
    [loadEarlier, props.botId, props.environmentId, t, topContentInset, usesNativeAutomaticInsets],
  );

  const listContentContainerStyle = useMemo(
    () => ({ paddingTop: 12, paddingHorizontal: contentHorizontalPadding }),
    [contentHorizontalPadding],
  );

  if (props.contentPresentation.kind === "unavailable") {
    return (
      <ThreadFeedPlaceholder
        title={props.contentPresentation.title}
        detail={props.contentPresentation.detail}
        topInset={topContentInset}
        bottomInset={bottomContentInset}
        horizontalPadding={horizontalPadding}
      />
    );
  }

  return (
    <>
      <View className="flex-1" onLayout={handleViewportLayout}>
        <View className="flex-1">
          <KeyboardAwareLegendList
            ref={props.listRef}
            // The empty↔filled key remounts the list when messages first
            // arrive. LegendList's maintainScrollAtEnd calls scrollToEnd(),
            // which is blind to UIKit's adjustedContentInset — inserting into
            // an already-attached list under a transparent header can pin
            // short content at offset 0 (one header-height too high). A fresh
            // mount positions during attach, where UIKit applies the inset.
            key={listMountKey}
            style={{ flex: 1 }}
            // RN 0.81+ drops touches inside the contentInset area
            // (facebook/react-native#54123); the anchored end space after a send
            // is pure inset, so without this the blank region can't be scrolled.
            applyWorkaroundForContentInsetHitTestBug
            contentInsetAdjustmentBehavior={usesNativeAutomaticInsets ? "automatic" : "never"}
            automaticallyAdjustsScrollIndicatorInsets={usesNativeAutomaticInsets}
            {...(usesNativeAutomaticInsets
              ? {
                  // Do NOT pass a manual `contentInset` here. Like the Home
                  // ScrollView, we rely purely on `contentInsetAdjustmentBehavior:
                  // "automatic"` so UIKit derives the top inset from the transparent
                  // header. A manual contentInset (which LegendList consumes into its
                  // own layout math) collapses the scroll view's adjustedContentInset
                  // top to 0, leaving the iOS 26/27 scroll-edge effect no region to
                  // render into — which is why the header blur was missing on threads.
                  scrollIndicatorInsets: { top: 0, left: 0, right: 0, bottom: 0 },
                }
              : { scrollIndicatorInsets: { top: topContentInset, bottom: 0 } })}
            {...(anchoredEndSpace ? { anchoredEndSpace } : {})}
            // Patched LegendList prop (patches/@legendapp__list@3.2.0.patch):
            // lets its scroll math clamp programmatic scrolls to -headerInset
            // instead of 0, so initialScrollAtEnd/maintainScrollAtEnd on short
            // content rest below the transparent header rather than at frame top.
            contentInsetStartAdjustment={usesNativeAutomaticInsets ? anchorTopInset : 0}
            contentInsetEndAdjustment={props.contentInsetEndAdjustment}
            // UIKit's automatic behavior adds the safe-area bottom on top of the
            // raw contentInset the keyboard integration writes. The detail screen
            // under-reports the composer inset by this amount (see
            // ThreadDetailScreen); this tells LegendList's scroll math about the
            // extra so programmatic end scrolls land at the true resting offset.
            contentInsetEndStaticAdjustment={usesNativeAutomaticInsets ? insets.bottom : 0}
            // Android: the composer overlay only exists as the keyboard
            // integration's animated bottom padding, which the list's scroll
            // math cannot see until the inset reports above land — and those
            // arrive via runOnJS, racing the remounted list's one-shot initial
            // scroll-at-end. Seed the estimated overlay height as a declarative
            // contentInset floor: LegendList consumes it in JS math only
            // (Android's ScrollView has no native contentInset prop) and the
            // first reported override REPLACES it instead of adding to it.
            // Not on iOS: there the prop would reach UIKit and inset natively
            // on top of the animated padding.
            {...(initialContentInset ? { contentInset: initialContentInset } : {})}
            // The keyboard integration's offset math (end pinning, max scroll)
            // must add the same UIKit-added extra, or its keyboard-open end
            // targets land one safe-area short of the true resting offset.
            adjustedInsetCompensation={usesNativeAutomaticInsets ? insets.bottom : 0}
            freeze={props.freeze}
            // Animated: on send, the optimistic message's dataChange fires
            // maintainScrollAtEnd before any render-cycle suppression could
            // engage — an instant snap there teleports the feed to the anchor
            // instead of scrolling to it. Keeping it enabled (animated) during
            // anchor scrolls also lets it correct a scroll that landed on a
            // stale end target once the anchor row finishes measuring.
            maintainScrollAtEnd={
              !endScrollMaintenanceActive
                ? false
                : {
                    animated: true,
                    on: {
                      dataChange: true,
                      itemLayout: true,
                      layout: true,
                    },
                  }
            }
            maintainVisibleContentPosition={maintainVisibleContentPosition}
            data={presentedFeed}
            extraData={feedRenderContext}
            renderItem={renderItem}
            keyExtractor={threadFeedKeyExtractor}
            getItemType={threadFeedItemType}
            itemsAreEqual={threadFeedEntriesEqual}
            getFixedItemSize={getFixedItemSize}
            // Measure rows well before they scroll into view so estimate→actual
            // corrections land offscreen instead of under the user's finger.
            drawDistance={500}
            keyboardShouldPersistTaps="always"
            keyboardDismissMode="none"
            keyboardLiftBehavior="whenAtEnd"
            // Seed the list's scroll math with the real viewport before its own
            // onLayout: the empty→filled remount can then tell at mount that
            // short content underflows the viewport and skip programmatic
            // positioning entirely (any offset write during screen attach races
            // UIKit's adjustedContentInset application and lands high or low).
            {...(viewportHeight > 0 && viewportWidth > 0
              ? { estimatedListSize: { height: viewportHeight, width: viewportWidth } }
              : {})}
            // RN's native scrollTo command clamps targets to a floor of
            // -contentInset.top using the RAW inset — under automatic insets the
            // header inset only exists in adjustedContentInset, so scrolls to
            // negative offsets (content top below the transparent header) get
            // clamped to 0. This prop disables that clamp; UIKit still bounces
            // user overscroll back to the adjusted rest position.
            scrollToOverflowEnabled
            estimatedItemSize={180}
            // Chat-style bottom alignment: when a thread is shorter than the
            // viewport, pad above the content so messages rest just above the
            // composer instead of under the header. No effect on threads that
            // overflow the viewport (the padding clamps to zero).
            alignItemsAtEnd
            initialScrollAtEnd
            {...scrollHandlers}
            scrollEventThrottle={16}
            ListHeaderComponent={listHeader}
            contentContainerStyle={listContentContainerStyle}
          />
        </View>
        {props.feed.length === 0 &&
        props.activeWorkStartedAt === null &&
        props.contentPresentation.kind === "ready" ? (
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <ThreadFeedPlaceholder
              title={t("No messages yet")}
              detail={t("Ask for a look at the project, or run a command to get started.")}
              topInset={topContentInset}
              bottomInset={bottomContentInset}
              horizontalPadding={horizontalPadding}
            />
          </View>
        ) : null}
      </View>

      <ImageViewing
        images={
          expandedImage
            ? [
                {
                  uri: expandedImage.uri,
                  headers: expandedImage.headers,
                },
              ]
            : []
        }
        imageIndex={0}
        visible={expandedImage !== null}
        onRequestClose={() => setExpandedImage(null)}
        swipeToCloseEnabled
        doubleTapToZoomEnabled
      />
    </>
  );
});
