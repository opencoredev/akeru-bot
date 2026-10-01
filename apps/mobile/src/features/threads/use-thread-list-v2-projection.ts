import type { EnvironmentProject, EnvironmentThreadShell } from "@akeru/client-runtime/state/shell";
import {
  threadSearchMatchKey,
  type EnvironmentThreadSearchMatch,
} from "@akeru/client-runtime/state/thread-search";
import { sortPinnedThreadsByOrderKey } from "@akeru/client-runtime/state/thread-sort";
import type { EnvironmentId, ServerConfig, SidebarProjectGroupingMode } from "@akeru/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { scopedProjectKey } from "../../lib/scopedEntities";
import { useThreadSearch } from "../../state/queries";
import { environmentServerConfigsAtom } from "../../state/server";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import type { WorkspaceEnvironment } from "../../state/workspaceModel";
import type { ThreadCapability } from "../home/environment-thread-capabilities";
import { buildHomeProjectScopes } from "../home/homeThreadList";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  THREAD_LIST_V2_SETTLED_PAGE_COUNT,
} from "./threadListV2";
import { useThreadListV2ShelfPreferences } from "./use-thread-list-v2-shelf-preferences";

type ServerConfigs = ReadonlyMap<EnvironmentId, ServerConfig>;

function environmentIdsWithCapability(
  serverConfigs: ServerConfigs,
  capability: ThreadCapability,
): ReadonlySet<EnvironmentId> {
  const supported = new Set<EnvironmentId>();
  for (const [environmentId, config] of serverConfigs) {
    if (config.environment.capabilities[capability] === true) {
      supported.add(environmentId);
    }
  }
  return supported;
}

/** Environments whose servers support each thread list action. */
function useThreadCapabilityEnvironmentIds(serverConfigs: ServerConfigs) {
  return useMemo(
    () => ({
      settlement: environmentIdsWithCapability(serverConfigs, "threadSettlement"),
      snooze: environmentIdsWithCapability(serverConfigs, "threadSnooze"),
      pinning: environmentIdsWithCapability(serverConfigs, "threadPinning"),
      pinReorder: environmentIdsWithCapability(serverConfigs, "threadPinReorder"),
      titleRegeneration: environmentIdsWithCapability(serverConfigs, "threadTitleRegeneration"),
    }),
    [serverConfigs],
  );
}

/**
 * The Thread List v2 model shared by the compact Home list and the iPad
 * sidebar: search matches, project scopes and lookups, server capabilities,
 * one flat card block in creation order with queued tasks spliced in, and the
 * paged settled tail. Settled threads stay in the live shell stream (settled
 * is not archived), so the partition works directly off live shells.
 * `selectedProjectKey` may name a project scope or one of its member projects.
 */
export function useThreadListV2Projection(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  /** Environments that can be searched while connected. */
  readonly searchEnvironments: ReadonlyArray<
    Pick<WorkspaceEnvironment, "environmentId" | "connectionState">
  >;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
  readonly searchQuery: string;
  readonly selectedThreadKey: string | null;
}) {
  const { selectedEnvironmentId, selectedProjectKey, searchQuery } = input;
  const searchEnvironmentIds = useMemo(
    () =>
      selectedEnvironmentId === null
        ? input.searchEnvironments
            .filter((environment) => environment.connectionState === "connected")
            .map((environment) => environment.environmentId)
        : input.searchEnvironments.some(
              (environment) =>
                environment.environmentId === selectedEnvironmentId &&
                environment.connectionState === "connected",
            )
          ? [selectedEnvironmentId]
          : [],
    [input.searchEnvironments, selectedEnvironmentId],
  );
  const threadSearch = useThreadSearch(searchEnvironmentIds, searchQuery);
  const threadSearchMatchByKey = useMemo(() => {
    const matches = new Map<string, EnvironmentThreadSearchMatch>();
    for (const match of threadSearch.matches) {
      if (match.source === "user" || match.source === "assistant") {
        matches.set(threadSearchMatchKey(match), match);
      }
    }
    return matches;
  }, [threadSearch.matches]);
  const matchedThreadKeys = useMemo(
    () => new Set(threadSearch.matches.map(threadSearchMatchKey)),
    [threadSearch.matches],
  );

  const projectScopes = useMemo(
    () =>
      buildHomeProjectScopes({
        projects: input.projects,
        environmentId: selectedEnvironmentId,
        projectGroupingMode: input.projectGroupingMode,
      }),
    [input.projectGroupingMode, input.projects, selectedEnvironmentId],
  );
  const projectCwdByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of input.projects) {
      map.set(scopedProjectKey(project.environmentId, project.id), project.workspaceRoot);
    }
    return map;
  }, [input.projects]);
  const projectByKey = useMemo(() => {
    const map = new Map<string, EnvironmentProject>();
    for (const project of input.projects) {
      map.set(scopedProjectKey(project.environmentId, project.id), project);
    }
    return map;
  }, [input.projects]);
  const selectedProjectScope = useMemo(
    () =>
      selectedProjectKey === null
        ? null
        : (projectScopes.find(
            (scope) =>
              scope.key === selectedProjectKey ||
              scope.projectRefs.some(
                (projectRef) =>
                  scopedProjectKey(projectRef.environmentId, projectRef.projectId) ===
                  selectedProjectKey,
              ),
          ) ?? null),
    [projectScopes, selectedProjectKey],
  );
  // Scope order is irrelevant here: scopes are only looked up by project key.
  const projectTitleByProjectKey = useMemo(
    () =>
      new Map(
        projectScopes.flatMap((scope) =>
          scope.projectRefs.map(
            (projectRef) =>
              [
                scopedProjectKey(projectRef.environmentId, projectRef.projectId),
                scope.title,
              ] as const,
          ),
        ),
      ),
    [projectScopes],
  );
  const selectedProjectRefs = useMemo(
    () =>
      selectedProjectScope === null
        ? null
        : new Set(
            selectedProjectScope.projectRefs.map((projectRef) =>
              scopedProjectKey(projectRef.environmentId, projectRef.projectId),
            ),
          ),
    [selectedProjectScope],
  );

  // The settled tail renders in pages; expansion resets when the filter
  // context changes so environment/search flips never inherit a deep page.
  const [settledVisibleCount, setSettledVisibleCount] = useState(
    THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  );
  const settledResetKey = `${selectedEnvironmentId ?? "all"}:${selectedProjectKey ?? "all"}:${searchQuery.trim()}`;
  const lastSettledResetKeyRef = useRef(settledResetKey);
  if (lastSettledResetKeyRef.current !== settledResetKey) {
    lastSettledResetKeyRef.current = settledResetKey;
    setSettledVisibleCount(THREAD_LIST_V2_SETTLED_INITIAL_COUNT);
  }
  const showMoreSettled = useCallback(
    () => setSettledVisibleCount((count) => count + THREAD_LIST_V2_SETTLED_PAGE_COUNT),
    [],
  );
  const shelves = useThreadListV2ShelfPreferences();
  const { settledShelfExpanded, snoozedShelfExpanded } = shelves;
  // A minute clock lets a queued turn leave its short adoption grace period
  // while the list stays open.
  const [nowMinute, setNowMinute] = useState(() => new Date().toISOString().slice(0, 16));
  // Snooze wake times are second-precise; a counter bumped exactly at the
  // next wake boundary re-runs the partition with a fresh clock so a woken
  // thread reappears immediately instead of on the next minute tick.
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
  useEffect(() => {
    // Refresh immediately because the mount-time value can be hours old.
    setNowMinute(new Date().toISOString().slice(0, 16));
    const id = setInterval(() => setNowMinute(new Date().toISOString().slice(0, 16)), 60_000);
    return () => clearInterval(id);
  }, []);
  // Threads on servers without the settlement capability never classify as
  // settled (the user could neither un-settle nor pin them).
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const capabilities = useThreadCapabilityEnvironmentIds(serverConfigs);
  // Canonical arranged pinned order (reorder-capable threads only) for the
  // Move up/down position flags. Computed from all shells, not the rendered
  // list, so search/scope filtering never disables or misdirects a move.
  const arrangedPinnedKeys = useMemo(() => {
    const pinned = sortPinnedThreadsByOrderKey(
      input.threads.filter(
        (thread) =>
          thread.pinnedAt != null &&
          thread.archivedAt === null &&
          capabilities.pinReorder.has(thread.environmentId),
      ),
    );
    return pinned.map((thread) => `${thread.environmentId}:${thread.id}`);
  }, [capabilities.pinReorder, input.threads]);
  const layout = useMemo(() => {
    // Settled threads are live shells; archived threads keep their original
    // "hidden from lists" meaning.
    return buildThreadListV2Items({
      threads: input.threads.filter((thread) => thread.archivedAt === null),
      environmentId: selectedEnvironmentId,
      projectRefs: selectedProjectScope === null ? null : selectedProjectScope.projectRefs,
      searchQuery,
      matchedThreadKeys,
      settlementEnvironmentIds: capabilities.settlement,
      snoozeEnvironmentIds: capabilities.snooze,
      settledLimit: settledVisibleCount,
      now: `${nowMinute}:00.000Z`,
      snoozeNow: new Date().toISOString(),
      snoozedShelfExpanded,
      settledShelfExpanded,
      selectedThreadKey: input.selectedThreadKey,
    });
  }, [
    nowMinute,
    snoozeWakeTick,
    snoozedShelfExpanded,
    settledShelfExpanded,
    settledVisibleCount,
    capabilities.settlement,
    capabilities.snooze,
    searchQuery,
    selectedEnvironmentId,
    input.selectedThreadKey,
    input.threads,
    matchedThreadKeys,
    selectedProjectScope,
  ]);
  // Re-partition the moment the earliest snooze expires (clamped to the
  // signed-32-bit setTimeout range; far-future wakes re-arm at the clamp).
  const nextSnoozeWakeAt = layout.nextSnoozeWakeAt;
  useEffect(() => {
    if (nextSnoozeWakeAt === null) return;
    const wakeAtMs = Date.parse(nextSnoozeWakeAt);
    if (Number.isNaN(wakeAtMs)) return;
    const delayMs = Math.min(Math.max(0, wakeAtMs - Date.now()) + 50, 2_147_483_647);
    const id = setTimeout(() => bumpSnoozeWakeTick((tick) => tick + 1), delayMs);
    return () => clearTimeout(id);
    // snoozeWakeTick must re-arm the timer even when nextSnoozeWakeAt is
    // unchanged: after a clamped fire (wake beyond the 32-bit setTimeout
    // range) the boundary string is identical and the chain would die.
  }, [nextSnoozeWakeAt, snoozeWakeTick]);
  // Queued tasks are not thread shells, so the v2 partition never sees them;
  // they are spliced in below the active block and stay visible and deletable
  // while their environment is offline. Same environment scope and search
  // filter as the list itself.
  const pendingSearchQuery = searchQuery.trim().toLocaleLowerCase();
  const visiblePendingTasks = useMemo(
    () =>
      input.pendingTasks.filter(
        (pendingTask) =>
          (selectedEnvironmentId === null ||
            pendingTask.message.environmentId === selectedEnvironmentId) &&
          (selectedProjectRefs === null ||
            selectedProjectRefs.has(
              scopedProjectKey(pendingTask.message.environmentId, pendingTask.creation.projectId),
            )) &&
          (pendingSearchQuery.length === 0 ||
            pendingTask.title.toLocaleLowerCase().includes(pendingSearchQuery)),
      ),
    [input.pendingTasks, selectedEnvironmentId, selectedProjectRefs, pendingSearchQuery],
  );
  const listItems = useMemo(
    () =>
      buildThreadListV2ListItems({
        items: layout.items,
        pendingTasks: visiblePendingTasks,
        snoozedCount: layout.snoozedCount,
        snoozedShelfExpanded,
        snoozedShelfHeaderIndex: layout.snoozedShelfHeaderIndex,
        settledCount: layout.settledCount,
        settledShelfExpanded,
        settledShelfHeaderIndex: layout.settledShelfHeaderIndex,
        snoozeLabelNow: `${nowMinute}:00.000Z`,
      }),
    [layout, nowMinute, settledShelfExpanded, snoozedShelfExpanded, visiblePendingTasks],
  );

  return {
    threadSearch,
    threadSearchMatchByKey,
    projectScopes,
    selectedProjectScope,
    projectByKey,
    projectCwdByKey,
    projectTitleByProjectKey,
    serverConfigs,
    capabilities,
    arrangedPinnedKeys,
    nowMinute,
    shelves,
    listItems,
    hiddenSettledCount: layout.hiddenSettledCount,
    showMoreSettled,
  };
}
