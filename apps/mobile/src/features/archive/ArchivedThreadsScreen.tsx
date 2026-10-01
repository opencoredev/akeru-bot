import type { EnvironmentProject, EnvironmentThreadShell } from "@akeru/client-runtime/state/shell";
import { LegendList } from "@legendapp/list/react-native";
import type { EnvironmentId } from "@akeru/contracts";
import { useCallback, useMemo, useRef } from "react";
import { ActivityIndicator, RefreshControl, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { useMobileI18n } from "../../lib/i18n";
import { useThemeColor } from "../../lib/useThemeColor";
import type { ArchivedThreadGroup, ArchivedThreadSortOrder } from "./archivedThreadList";
import {
  ArchivedThreadsHeader,
  type ArchivedThreadsHeaderEnvironment,
} from "./ArchivedThreadsHeader";
import { ArchiveError, ArchivedThreadRow, ProjectGroupLabel } from "./archived-thread-rows";

export type { ArchivedThreadsHeaderEnvironment } from "./ArchivedThreadsHeader";

type ArchivedThreadListItem =
  | {
      readonly kind: "project";
      readonly key: string;
      readonly environmentLabel: string | null;
      readonly project: EnvironmentProject;
    }
  | {
      readonly kind: "thread";
      readonly key: string;
      readonly environmentLabel: string | null;
      readonly isFirst: boolean;
      readonly isLast: boolean;
      readonly thread: EnvironmentThreadShell;
    };

export function ArchivedThreadsScreen(props: {
  readonly environments: ReadonlyArray<ArchivedThreadsHeaderEnvironment>;
  readonly error: string | null;
  readonly groups: ReadonlyArray<ArchivedThreadGroup>;
  readonly isLoading: boolean;
  readonly searchQuery: string;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly sortOrder: ArchivedThreadSortOrder;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onRefresh: () => void;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onSortOrderChange: (sortOrder: ArchivedThreadSortOrder) => void;
  readonly onUnarchiveThread: (thread: EnvironmentThreadShell) => void;
}) {
  const { onDeleteThread, onUnarchiveThread } = props;
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const archiveScrollGesture = useMemo(() => Gesture.Native(), []);
  const { t } = useMobileI18n();
  const refreshTint = useThemeColor("--color-icon");

  const environmentLabelsById = useMemo(
    () =>
      new Map(
        props.environments.map((environment) => [environment.environmentId, environment.label]),
      ),
    [props.environments],
  );

  const listItems = useMemo<ReadonlyArray<ArchivedThreadListItem>>(() => {
    const items: ArchivedThreadListItem[] = [];

    for (const group of props.groups) {
      const environmentLabel = environmentLabelsById.get(group.project.environmentId) ?? null;
      items.push({
        kind: "project",
        key: `${group.key}:project`,
        environmentLabel,
        project: group.project,
      });

      group.threads.forEach((thread, index) => {
        items.push({
          kind: "thread",
          key: `${thread.environmentId}:${thread.id}`,
          environmentLabel,
          isFirst: index === 0,
          isLast: index === group.threads.length - 1,
          thread,
        });
      });
    }

    return items;
  }, [environmentLabelsById, props.groups]);

  const handleSwipeableWillOpen = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current && openSwipeableRef.current !== methods) {
      openSwipeableRef.current.close();
    }

    openSwipeableRef.current = methods;
  }, []);

  const handleSwipeableClose = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current === methods) {
      openSwipeableRef.current = null;
    }
  }, []);

  const isInitialLoad = props.isLoading && props.groups.length === 0 && props.error === null;
  const isFiltered = props.searchQuery.trim().length > 0 || props.selectedEnvironmentId !== null;

  const renderListItem = useCallback(
    ({ item }: { item: ArchivedThreadListItem }) => {
      if (item.kind === "project") {
        return (
          <View className="pt-4">
            <ProjectGroupLabel environmentLabel={item.environmentLabel} project={item.project} />
          </View>
        );
      }

      return (
        <ArchivedThreadRow
          environmentLabel={item.environmentLabel}
          isFirst={item.isFirst}
          isLast={item.isLast}
          onDelete={() => onDeleteThread(item.thread)}
          onSwipeableClose={handleSwipeableClose}
          onSwipeableWillOpen={handleSwipeableWillOpen}
          onUnarchive={() => onUnarchiveThread(item.thread)}
          simultaneousSwipeGesture={archiveScrollGesture}
          thread={item.thread}
        />
      );
    },
    [
      archiveScrollGesture,
      handleSwipeableClose,
      handleSwipeableWillOpen,
      onDeleteThread,
      onUnarchiveThread,
    ],
  );

  const listEmptyComponent = useMemo(() => {
    if (isInitialLoad) {
      return (
        <View className="items-center py-16">
          <ActivityIndicator color={refreshTint} />
          <Text className="mt-3 text-sm text-foreground-muted">{t("Loading archive…")}</Text>
        </View>
      );
    }

    return (
      <EmptyState
        detail={
          isFiltered
            ? t("Try another search or environment.")
            : t("Chats you archive will appear here.")
        }
        title={isFiltered ? t("No matching chats") : t("No archived chats")}
      />
    );
  }, [isFiltered, isInitialLoad, refreshTint, t]);

  return (
    <View className="flex-1 bg-sheet">
      <ArchivedThreadsHeader
        environments={props.environments}
        searchQuery={props.searchQuery}
        onEnvironmentChange={props.onEnvironmentChange}
        onRefresh={props.onRefresh}
        onSearchQueryChange={props.onSearchQueryChange}
        onSortOrderChange={props.onSortOrderChange}
        selectedEnvironmentId={props.selectedEnvironmentId}
        sortOrder={props.sortOrder}
      />

      <GestureDetector gesture={archiveScrollGesture}>
        <LegendList
          className="flex-1"
          contentContainerStyle={{
            paddingBottom: 32,
            paddingHorizontal: 16,
            paddingTop: 4,
          }}
          contentInsetAdjustmentBehavior="automatic"
          data={listItems}
          estimatedItemSize={62}
          getItemType={(item) => item.kind}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          keyExtractor={(item) => item.key}
          ListEmptyComponent={listEmptyComponent}
          ListHeaderComponent={
            props.error ? <ArchiveError message={props.error} onRetry={props.onRefresh} /> : null
          }
          onScrollBeginDrag={() => openSwipeableRef.current?.close()}
          refreshControl={
            <RefreshControl
              onRefresh={props.onRefresh}
              refreshing={props.isLoading && !isInitialLoad}
              tintColor={String(refreshTint)}
            />
          }
          renderItem={renderListItem}
          showsVerticalScrollIndicator={false}
        />
      </GestureDetector>
    </View>
  );
}
