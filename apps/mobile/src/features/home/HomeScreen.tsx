import { useMobileI18n } from "../../lib/i18n";
import type { EnvironmentProject, EnvironmentThreadShell } from "@akeru/client-runtime/state/shell";
import { threadSearchMatchKey } from "@akeru/client-runtime/state/thread-search";
import type { EnvironmentId, SidebarProjectGroupingMode } from "@akeru/contracts";
import { useCallback, useMemo, useRef } from "react";
import { ActivityIndicator, FlatList, Pressable, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "../../lib/useThemeColor";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { EmptyState } from "../../components/EmptyState";
import type { WorkspaceEnvironment, WorkspaceState } from "../../state/workspaceModel";
import { deriveHomeEmptyState } from "./home-empty-state";
import type { SavedRemoteConnection } from "../../lib/connection";
import { scopedProjectKey } from "../../lib/scopedEntities";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import {
  ThreadListV2PendingRow,
  ThreadListV2Row,
  threadListV2TimeLabel,
  ThreadListV2SettledShelfHeader,
  ThreadListV2SnoozedShelfHeader,
} from "../threads/thread-list-v2-items";
import {
  THREAD_LIST_V2_SETTLED_PAGE_COUNT,
  type ThreadListV2ListItem,
} from "../threads/threadListV2";
import type { HomeListFilterMenuEnvironment } from "./home-list-filter-menu";
import { SwipeableScrollGateProvider, useSwipeableScrollGate } from "./thread-swipe-actions";
import { useThreadListV2Projection } from "../threads/use-thread-list-v2-projection";

/* ─── Types ──────────────────────────────────────────────────────────── */

interface HomeScreenProps {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly catalogState: WorkspaceState;
  readonly savedConnectionsById: Readonly<Record<string, SavedRemoteConnection>>;
  readonly environments: ReadonlyArray<
    HomeListFilterMenuEnvironment & Pick<WorkspaceEnvironment, "connectionState">
  >;
  readonly searchQuery: string;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly onAddConnection: () => void;
  readonly onRetryEnvironments: () => void;
  readonly onOpenSettings: () => void;
  readonly onStartNewTask: () => void;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  /** Resolves true iff the settle was dispatched and succeeded. */
  readonly onSettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onSnoozeThread: (
    thread: EnvironmentThreadShell,
    snoozedUntil: string,
  ) => Promise<boolean>;
  readonly onUnsnoozeThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onUnsettleThread: (thread: EnvironmentThreadShell) => void;
  readonly onPinThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onUnpinThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onMovePinnedThread: (
    thread: EnvironmentThreadShell,
    direction: "up" | "down",
  ) => Promise<boolean>;
  readonly onRegenerateThreadTitle: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onSelectPendingTask: (pendingTask: PendingNewTask) => void;
  readonly onDeletePendingTask: (pendingTask: PendingNewTask) => void;
}

/* ─── Layout constants ───────────────────────────────────────────────── */

/**
 * Top spacing between the list and the Android custom header. The Android
 * header (AndroidHomeHeader) is rendered in-flow above this screen and
 * already consumes the top safe-area inset, so the list only needs breathing
 * room here.
 */

/* ─── Main screen ────────────────────────────────────────────────────── */

export function HomeScreen(props: HomeScreenProps) {
  const { t } = useMobileI18n();
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const insets = useSafeAreaInsets();
  const accentColor = useThemeColor("--color-icon-muted");
  const {
    threadSearch,
    threadSearchMatchByKey,
    selectedProjectScope: v2ScopedProjectGroup,
    projectByKey,
    projectCwdByKey,
    projectTitleByProjectKey: v2ProjectTitleByProjectKey,
    serverConfigs,
    capabilities,
    arrangedPinnedKeys,
    nowMinute,
    shelves,
    listItems: threadListV2Items,
    hiddenSettledCount,
    showMoreSettled,
  } = useThreadListV2Projection({
    threads: props.threads,
    projects: props.projects,
    pendingTasks: props.pendingTasks,
    searchEnvironments: props.environments,
    selectedEnvironmentId: props.selectedEnvironmentId,
    selectedProjectKey: props.selectedProjectKey,
    projectGroupingMode: props.projectGroupingMode,
    searchQuery: props.searchQuery,
    selectedThreadKey: null,
  });
  const {
    settlement: settlementEnvironmentIds,
    snooze: snoozeEnvironmentIds,
    pinning: pinningEnvironmentIds,
    pinReorder: pinReorderEnvironmentIds,
    titleRegeneration: titleRegenerationEnvironmentIds,
  } = capabilities;
  const {
    loaded: shelfPreferencesLoaded,
    settledShelfExpanded,
    toggleSettledShelf,
    toggleSnoozedShelf,
  } = shelves;
  const handleSwipeableWillOpen = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current !== methods) {
      openSwipeableRef.current?.close();
      openSwipeableRef.current = methods;
    }
  }, []);

  const handleSwipeableClose = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current === methods) {
      openSwipeableRef.current = null;
    }
  }, []);

  const handleScrollBeginDrag = useCallback(() => {
    openSwipeableRef.current?.close();
  }, []);
  const { swipeEnabled, scrollGateHandlers } = useSwipeableScrollGate({
    onScrollBeginDrag: handleScrollBeginDrag,
  });

  const handleSettleThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onSettleThread(thread);
    },
    [props.onSettleThread],
  );
  const handleSnoozeThread = useCallback(
    (thread: EnvironmentThreadShell, snoozedUntil: string) => {
      void props.onSnoozeThread(thread, snoozedUntil);
    },
    [props.onSnoozeThread],
  );
  const handleUnsnoozeThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onUnsnoozeThread(thread);
    },
    [props.onUnsnoozeThread],
  );
  const handlePinThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onPinThread(thread);
    },
    [props.onPinThread],
  );
  const handleMovePinnedThread = useCallback(
    (thread: EnvironmentThreadShell, direction: "up" | "down") => {
      void props.onMovePinnedThread(thread, direction);
    },
    [props.onMovePinnedThread],
  );
  const handleUnpinThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onUnpinThread(thread);
    },
    [props.onUnpinThread],
  );
  const handleRegenerateThreadTitle = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onRegenerateThreadTitle(thread);
    },
    [props.onRegenerateThreadTitle],
  );
  const handleDeleteThread = props.onDeleteThread;
  const handleUnsettleThread = props.onUnsettleThread;

  const renderV2Item = useCallback(
    ({ item, index }: { readonly item: ThreadListV2ListItem; readonly index: number }) => {
      const nextItem = threadListV2Items[index + 1];
      const showTrailingDivider =
        nextItem?.type === "v2-thread" ||
        (nextItem?.type === "v2-pending" && !nextItem.showPendingDivider);
      if (item.type === "v2-pending") {
        const pendingScopeKey = scopedProjectKey(
          item.pendingTask.message.environmentId,
          item.pendingTask.creation.projectId,
        );
        return (
          <ThreadListV2PendingRow
            pendingTask={item.pendingTask}
            project={projectByKey.get(pendingScopeKey) ?? null}
            projectTitle={v2ProjectTitleByProjectKey.get(pendingScopeKey)}
            environmentLabel={
              Object.keys(props.savedConnectionsById).length > 1
                ? (props.savedConnectionsById[item.pendingTask.message.environmentId]
                    ?.environmentLabel ?? null)
                : null
            }
            showPendingDivider={item.showPendingDivider}
            showTrailingDivider={showTrailingDivider}
            onSelectPendingTask={props.onSelectPendingTask}
            onDeletePendingTask={props.onDeletePendingTask}
          />
        );
      }
      if (item.type === "v2-snoozed-shelf") {
        return (
          <ThreadListV2SnoozedShelfHeader
            count={item.count}
            disabled={!shelfPreferencesLoaded}
            expanded={item.expanded}
            onToggle={toggleSnoozedShelf}
          />
        );
      }
      if (item.type === "v2-settled-shelf") {
        return (
          <ThreadListV2SettledShelfHeader
            count={item.count}
            disabled={!shelfPreferencesLoaded}
            expanded={item.expanded}
            onToggle={toggleSettledShelf}
          />
        );
      }
      const thread = item.item.thread;
      return (
        <ThreadListV2Row
          thread={thread}
          variant={item.item.variant}
          snoozed={item.item.snoozed}
          pinned={item.item.pinned}
          timeLabel={threadListV2TimeLabel(thread)}
          snoozePresetMinute={
            !item.item.snoozed && snoozeEnvironmentIds.has(thread.environmentId) ? nowMinute : null
          }
          snoozeWakeLabelText={item.snoozeWakeLabelText}
          showTrailingDivider={showTrailingDivider}
          project={
            projectByKey.get(scopedProjectKey(thread.environmentId, thread.projectId)) ?? null
          }
          projectTitle={v2ProjectTitleByProjectKey.get(
            scopedProjectKey(thread.environmentId, thread.projectId),
          )}
          providerDriver={
            serverConfigs
              .get(thread.environmentId)
              ?.providers.find(
                (provider) =>
                  provider.instanceId ===
                  (thread.session?.providerInstanceId ?? thread.modelSelection.instanceId),
              )?.driver ?? null
          }
          environmentLabel={
            Object.keys(props.savedConnectionsById).length > 1
              ? (props.savedConnectionsById[thread.environmentId]?.environmentLabel ?? null)
              : null
          }
          searchMatch={threadSearchMatchByKey.get(
            threadSearchMatchKey({
              environmentId: thread.environmentId,
              threadId: thread.id,
            }),
          )}
          searchQuery={props.searchQuery}
          onSelectThread={props.onSelectThread}
          onDeleteThread={handleDeleteThread}
          onArchiveThread={props.onArchiveThread}
          onRegenerateThreadTitle={handleRegenerateThreadTitle}
          titleRegenerationSupported={titleRegenerationEnvironmentIds.has(thread.environmentId)}
          settlementSupported={settlementEnvironmentIds.has(thread.environmentId)}
          onSettleThread={handleSettleThread}
          snoozeSupported={snoozeEnvironmentIds.has(thread.environmentId)}
          pinningSupported={pinningEnvironmentIds.has(thread.environmentId)}
          pinReorderSupported={pinReorderEnvironmentIds.has(thread.environmentId)}
          canMovePinnedUp={arrangedPinnedKeys.indexOf(`${thread.environmentId}:${thread.id}`) > 0}
          canMovePinnedDown={(() => {
            const index = arrangedPinnedKeys.indexOf(`${thread.environmentId}:${thread.id}`);
            return index !== -1 && index < arrangedPinnedKeys.length - 1;
          })()}
          onSnoozeThread={handleSnoozeThread}
          onUnsnoozeThread={handleUnsnoozeThread}
          onUnsettleThread={handleUnsettleThread}
          onPinThread={handlePinThread}
          onUnpinThread={handleUnpinThread}
          onMovePinnedThread={handleMovePinnedThread}
          projectCwd={
            projectCwdByKey.get(scopedProjectKey(thread.environmentId, thread.projectId)) ?? null
          }
          onSwipeableClose={handleSwipeableClose}
          onSwipeableWillOpen={handleSwipeableWillOpen}
        />
      );
    },
    [
      handleDeleteThread,
      arrangedPinnedKeys,
      handleMovePinnedThread,
      handlePinThread,
      handleRegenerateThreadTitle,
      handleSettleThread,
      handleSnoozeThread,
      handleUnpinThread,
      handleUnsnoozeThread,
      handleSwipeableClose,
      handleSwipeableWillOpen,
      handleUnsettleThread,
      pinningEnvironmentIds,
      pinReorderEnvironmentIds,
      projectByKey,
      projectCwdByKey,
      props.onArchiveThread,
      props.onDeletePendingTask,
      props.onSelectPendingTask,
      props.onSelectThread,
      props.savedConnectionsById,
      serverConfigs,
      shelfPreferencesLoaded,
      settlementEnvironmentIds,
      snoozeEnvironmentIds,
      threadListV2Items,
      threadSearchMatchByKey,
      titleRegenerationEnvironmentIds,
      toggleSettledShelf,
      toggleSnoozedShelf,
      v2ProjectTitleByProjectKey,
      props.searchQuery,
      nowMinute,
    ],
  );
  const v2KeyExtractor = useCallback((item: ThreadListV2ListItem) => item.key, []);

  // FlatList treats a changed extraData identity as "re-render every visible
  // row", so an inline object literal would invalidate all rows on every
  // HomeScreen render.
  const v2ExtraData = useMemo(
    () => ({
      projectByKey,
      projectCwdByKey,
      projectTitleByProjectKey: v2ProjectTitleByProjectKey,
      serverConfigs,
      savedConnectionsById: props.savedConnectionsById,
      searchQuery: props.searchQuery,
      snoozePresetMinute: nowMinute,
      threadSearchMatchByKey,
    }),
    [
      projectByKey,
      projectCwdByKey,
      props.searchQuery,
      props.savedConnectionsById,
      serverConfigs,
      nowMinute,
      threadSearchMatchByKey,
      v2ProjectTitleByProjectKey,
    ],
  );

  /* Empty states */
  // The signal must ignore the search/environment filters: an active query
  // that matches nothing needs the in-list "No results" state, not the
  // full-page "No chats yet". Settled threads are unarchived live shells,
  // so they count here too.
  const hasAnyThreads =
    props.threads.some((thread) => thread.archivedAt === null) || props.pendingTasks.length > 0;
  const hasSearchQuery = props.searchQuery.trim().length > 0;
  const selectedEnvironmentLabel =
    props.selectedEnvironmentId === null
      ? null
      : (props.savedConnectionsById[props.selectedEnvironmentId]?.environmentLabel ??
        "this environment");
  // Connection state surfaces in the header title slot
  // (WorkspaceConnectionTitle) — nothing renders inside the list, so
  // reconnects never shift the rows.
  const emptyState = deriveHomeEmptyState({
    catalogState: props.catalogState,
    projectCount: props.projects.length,
  });

  if (!hasAnyThreads) {
    const emptyAction = emptyState.retry
      ? { label: t("Try again"), onPress: props.onRetryEnvironments }
      : !props.catalogState.hasReadyEnvironment
        ? { label: "Add environment", onPress: props.onAddConnection }
        : { label: "New chat", onPress: props.onStartNewTask };
    return (
      <View className="flex-1 bg-screen">
        <View
          className="flex-1 items-center justify-center px-8"
          style={{ paddingBottom: Math.max(insets.bottom, 24) + 24 }}
        >
          <View className="size-20 items-center justify-center rounded-full bg-subtle">
            <SymbolView name="text.bubble" size={30} tintColor={accentColor} type="monochrome" />
          </View>
          <Text className="mt-6 text-center text-[22px] font-t3-bold text-foreground">
            {emptyState.title}
          </Text>
          <Text className="mt-2 max-w-[430px] text-center font-sans text-base leading-normal text-foreground-muted">
            {emptyState.detail}
          </Text>
          {emptyState.loading ? (
            <View className="mt-5 items-center">
              <ActivityIndicator color={accentColor} />
            </View>
          ) : (
            <Pressable
              className="mt-7 rounded-full border border-border-subtle bg-card px-6 py-3.5"
              onPress={emptyAction.onPress}
              style={({ pressed }) => ({
                elevation: 6,
                opacity: pressed ? 0.7 : 1,
                shadowColor: "#000000",
                shadowOffset: { height: 5, width: 0 },
                shadowOpacity: 0.1,
                shadowRadius: 14,
              })}
            >
              <Text className="text-[16px] font-t3-bold text-foreground">{emptyAction.label}</Text>
            </Pressable>
          )}
        </View>
      </View>
    );
  }

  const listHeader = null;

  // Project scoping lives in the header filter menu (no inline chip row on
  // mobile — the menu is the one filter surface). Snoozed threads need no
  // special empty state: their shelf header is a list row even while collapsed.
  const listEmpty =
    hasSearchQuery && threadSearch.isPending ? null : hasSearchQuery ? (
      <EmptyState
        title={t("No results")}
        detail={t('No chats matching "{query}".', { query: props.searchQuery })}
      />
    ) : v2ScopedProjectGroup !== null ? (
      <EmptyState
        title={`No chats in ${v2ScopedProjectGroup.title}`}
        detail="Choose another project or talk to a bot."
      />
    ) : selectedEnvironmentLabel ? (
      <EmptyState
        title={`No chats in ${selectedEnvironmentLabel}`}
        detail="Choose another environment or talk to a bot."
      />
    ) : (
      <EmptyState title={t("No chats yet")} detail={t("Pick a bot to start a chat.")} />
    );

  return (
    <View className="flex-1 bg-screen">
      <SwipeableScrollGateProvider enabled={swipeEnabled}>
        <FlatList
          data={threadListV2Items}
          renderItem={renderV2Item}
          keyExtractor={v2KeyExtractor}
          extraData={v2ExtraData}
          ListHeaderComponent={listHeader}
          ListFooterComponent={
            settledShelfExpanded && hiddenSettledCount > 0 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Show ${Math.min(hiddenSettledCount, THREAD_LIST_V2_SETTLED_PAGE_COUNT)} more chats`}
                onPress={showMoreSettled}
                className="mx-4 mt-2 items-center rounded-lg border border-dashed border-border py-2.5"
                style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
              >
                <Text className="text-xs font-t3-medium text-foreground-muted">
                  Show more ({hiddenSettledCount} settled hidden)
                </Text>
              </Pressable>
            ) : null
          }
          ListEmptyComponent={listEmpty}
          style={{ flex: 1 }}
          automaticallyAdjustsScrollIndicatorInsets={false}
          contentInsetAdjustmentBehavior="never"
          showsVerticalScrollIndicator={false}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          {...scrollGateHandlers}
          scrollEventThrottle={16}
          contentContainerStyle={{
            paddingBottom: Math.max(insets.bottom, 16) + 24,
          }}
        />
      </SwipeableScrollGateProvider>
    </View>
  );
}
