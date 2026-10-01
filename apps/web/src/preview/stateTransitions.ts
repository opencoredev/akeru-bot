import { hasTag } from "~/lib/taggedUnion";
import {
  type DesktopPreviewColorScheme,
  type DesktopPreviewFavicon,
  type PreviewEvent,
  type PreviewFrame,
  type PreviewListResult,
  type PreviewSessionSnapshot,
} from "@akeru/contracts";
import { PREVIEW_RECENT_URL_LIMIT } from "../components/preview/previewConstants";

export interface DesktopPreviewOverlay {
  hasWebContents: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  zoomFactor: number;
  pictureInPicture: boolean;
  colorScheme: DesktopPreviewColorScheme;
  audioMuted: boolean;
  audible: boolean;
  controller: "human" | "agent" | "none";
  favicon: DesktopPreviewFavicon | null;
}

export interface ThreadPreviewState {
  snapshot: PreviewSessionSnapshot | null;
  sessions: Record<string, PreviewSessionSnapshot>;
  /** Tabs intentionally closed by this client. Stale list snapshots must not resurrect them. */
  suppressedTabIds: ReadonlySet<string>;
  activeTabId: string | null;
  desktopOverlay: DesktopPreviewOverlay | null;
  desktopByTabId: Record<string, DesktopPreviewOverlay>;
  framesByTabId: Record<string, PreviewFrame>;
  recentlySeenUrls: string[];
  /** Server process currently authoritative for revision ordering. */
  serverEpoch: string | null;
  /** Latest ordered server revision applied from a list response or event. */
  serverRevision: number;
}

export const EMPTY_THREAD_PREVIEW_STATE: ThreadPreviewState = Object.freeze({
  snapshot: null,
  sessions: {},
  suppressedTabIds: new Set<string>(),
  activeTabId: null,
  desktopOverlay: null,
  desktopByTabId: {},
  framesByTabId: {},
  recentlySeenUrls: [] as string[],
  serverEpoch: null,
  serverRevision: 0,
});

const dedupeRecentUrls = (existing: string[], url: string): string[] => {
  const next = [url, ...existing.filter((entry) => entry !== url)];

  return next.slice(0, PREVIEW_RECENT_URL_LIMIT);
};

const rememberSnapshotUrl = (
  recentlySeenUrls: string[],
  snapshot: PreviewSessionSnapshot,
): string[] =>
  hasTag(snapshot.navStatus, "Idle")
    ? recentlySeenUrls
    : dedupeRecentUrls(recentlySeenUrls, snapshot.navStatus.url);

const latestSnapshot = (
  sessions: Record<string, PreviewSessionSnapshot>,
): PreviewSessionSnapshot | null =>
  Object.values(sessions)
    .toSorted((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .at(-1) ?? null;

const removeSession = (current: ThreadPreviewState, tabId: string): ThreadPreviewState => {
  if (!current.sessions[tabId]) return current;
  const { [tabId]: _closed, ...sessions } = current.sessions;
  const { [tabId]: _desktop, ...desktopByTabId } = current.desktopByTabId;
  const { [tabId]: _frame, ...framesByTabId } = current.framesByTabId;
  const nextSnapshot = latestSnapshot(sessions);

  const activeTabId =
    current.activeTabId === tabId ? (nextSnapshot?.tabId ?? null) : current.activeTabId;

  const snapshot = activeTabId ? (sessions[activeTabId] ?? nextSnapshot) : nextSnapshot;

  return {
    ...current,
    sessions,
    desktopByTabId,
    framesByTabId,
    activeTabId: snapshot?.tabId ?? null,
    snapshot,
    desktopOverlay: snapshot ? (desktopByTabId[snapshot.tabId] ?? null) : null,
  };
};

function isPreviewStateEqual(
  previous: DesktopPreviewOverlay | null,
  next: DesktopPreviewOverlay | null,
) {
  return (
    previous === next ||
    (previous !== null &&
      next !== null &&
      previous.hasWebContents === next.hasWebContents &&
      previous.canGoBack === next.canGoBack &&
      previous.canGoForward === next.canGoForward &&
      previous.loading === next.loading &&
      previous.zoomFactor === next.zoomFactor &&
      previous.pictureInPicture === next.pictureInPicture &&
      previous.colorScheme === next.colorScheme &&
      previous.audioMuted === next.audioMuted &&
      previous.audible === next.audible &&
      previous.controller === next.controller &&
      previous.favicon?.dataUrl === next.favicon?.dataUrl &&
      previous.favicon?.pageUrl === next.favicon?.pageUrl &&
      previous.favicon?.capturedAt === next.favicon?.capturedAt)
  );
}

export function applyPreviewServerEventTransition(
  current: ThreadPreviewState,
  event: PreviewEvent,
): ThreadPreviewState {
  if (current.serverEpoch !== null && event.serverEpoch !== current.serverEpoch) return current;

  if (event.revision < current.serverRevision) return current;

  const next = (() => {
    switch (event.type) {
      case "opened":
      case "navigated":
      case "resized": {
        const snapshot = event.snapshot;

        if (current.suppressedTabIds.has(snapshot.tabId)) return current;

        const recentlySeenUrls = hasTag(snapshot.navStatus, "Idle")
          ? current.recentlySeenUrls
          : dedupeRecentUrls(current.recentlySeenUrls, snapshot.navStatus.url);

        const sessions = { ...current.sessions, [snapshot.tabId]: snapshot };
        const activeTabId = event.type === "opened" ? snapshot.tabId : current.activeTabId;
        const activeSnapshot = sessions[activeTabId ?? snapshot.tabId] ?? snapshot;

        return {
          ...current,
          sessions,
          activeTabId: activeTabId ?? snapshot.tabId,
          snapshot: activeSnapshot,
          desktopOverlay: current.desktopByTabId[activeSnapshot.tabId] ?? null,
          recentlySeenUrls,
        };
      }

      case "failed": {
        const existing = current.sessions[event.tabId];

        if (!existing) return current;

        const failedSnapshot = {
          ...existing,
          navStatus: {
            _tag: "LoadFailed" as const,
            url: event.url,
            title: event.title,
            code: event.code,
            description: event.description,
          },
          updatedAt: event.createdAt,
        };

        const sessions = { ...current.sessions, [event.tabId]: failedSnapshot };

        return {
          ...current,
          sessions,
          snapshot: current.activeTabId === event.tabId ? failedSnapshot : current.snapshot,
        };
      }

      case "closed": {
        const closed = removeSession(current, event.tabId);

        if (!closed.suppressedTabIds.has(event.tabId)) return closed;
        const suppressedTabIds = new Set(closed.suppressedTabIds);
        suppressedTabIds.delete(event.tabId);

        return { ...closed, suppressedTabIds };
      }

      case "frame": {
        if (!current.sessions[event.tabId]) return current;

        return {
          ...current,
          framesByTabId: { ...current.framesByTabId, [event.tabId]: event.frame },
        };
      }
    }
  })();

  return next.serverRevision === event.revision && next.serverEpoch === event.serverEpoch
    ? next
    : {
        ...next,
        serverEpoch: event.serverEpoch,
        serverRevision: event.revision,
      };
}

export function applyPreviewServerSnapshotTransition(
  current: ThreadPreviewState,
  snapshot: PreviewSessionSnapshot | null,
): ThreadPreviewState {
  if (!snapshot && current.snapshot === null) return current;

  if (!snapshot) {
    return {
      ...current,
      snapshot: null,
      sessions: {},
      activeTabId: null,
      desktopOverlay: null,
      desktopByTabId: {},
      framesByTabId: {},
    };
  }

  if (current.suppressedTabIds.has(snapshot.tabId)) return current;
  const existing = current.sessions[snapshot.tabId];

  if (existing && existing.updatedAt > snapshot.updatedAt) return current;
  const recentlySeenUrls = rememberSnapshotUrl(current.recentlySeenUrls, snapshot);

  return {
    ...current,
    snapshot,
    sessions: { ...current.sessions, [snapshot.tabId]: snapshot },
    activeTabId: snapshot.tabId,
    desktopOverlay: current.desktopByTabId[snapshot.tabId] ?? null,
    recentlySeenUrls,
  };
}

export function updatePreviewServerSnapshotTransition(
  current: ThreadPreviewState,
  snapshot: PreviewSessionSnapshot,
): ThreadPreviewState {
  if (current.suppressedTabIds.has(snapshot.tabId)) return current;
  const existing = current.sessions[snapshot.tabId];

  if (existing && existing.updatedAt > snapshot.updatedAt) return current;
  const sessions = { ...current.sessions, [snapshot.tabId]: snapshot };

  const activeTabId =
    current.activeTabId && sessions[current.activeTabId] ? current.activeTabId : snapshot.tabId;

  const activeSnapshot = sessions[activeTabId] ?? snapshot;

  return {
    ...current,
    sessions,
    activeTabId,
    snapshot: activeSnapshot,
    desktopOverlay: current.desktopByTabId[activeTabId] ?? null,
    recentlySeenUrls: rememberSnapshotUrl(current.recentlySeenUrls, snapshot),
  };
}

export function reconcilePreviewServerSessionsTransition(
  current: ThreadPreviewState,
  result: PreviewListResult,
): ThreadPreviewState {
  const sameServer = current.serverEpoch === result.serverEpoch;

  if (sameServer && result.revision < current.serverRevision) return current;
  const snapshots = result.sessions;
  const sessions: Record<string, PreviewSessionSnapshot> = {};
  const currentSuppressedTabIds = sameServer ? current.suppressedTabIds : new Set<string>();
  let recentlySeenUrls = current.recentlySeenUrls;

  for (const snapshot of snapshots) {
    if (currentSuppressedTabIds.has(snapshot.tabId)) continue;
    const existing = sameServer ? current.sessions[snapshot.tabId] : undefined;
    const next = existing && existing.updatedAt > snapshot.updatedAt ? existing : snapshot;
    sessions[next.tabId] = next;
    recentlySeenUrls = rememberSnapshotUrl(recentlySeenUrls, next);
  }

  const fallback = latestSnapshot(sessions);

  const activeTabId =
    current.activeTabId && sessions[current.activeTabId]
      ? current.activeTabId
      : (fallback?.tabId ?? null);

  const snapshot = activeTabId ? (sessions[activeTabId] ?? null) : null;

  const desktopByTabId = sameServer
    ? Object.fromEntries(
        Object.entries(current.desktopByTabId).filter(([tabId]) => sessions[tabId] !== undefined),
      )
    : {};

  const framesByTabId = sameServer
    ? Object.fromEntries(
        Object.entries(current.framesByTabId).filter(([tabId]) => sessions[tabId] !== undefined),
      )
    : {};

  const suppressedTabIds = new Set(
    [...currentSuppressedTabIds].filter((tabId) =>
      snapshots.some((snapshot) => snapshot.tabId === tabId),
    ),
  );

  return {
    ...current,
    sessions,
    suppressedTabIds,
    activeTabId,
    snapshot,
    desktopByTabId,
    framesByTabId,
    desktopOverlay: activeTabId ? (desktopByTabId[activeTabId] ?? null) : null,
    recentlySeenUrls,
    serverEpoch: result.serverEpoch,
    serverRevision: result.revision,
  };
}

export function applyPreviewDesktopStateTransition(
  current: ThreadPreviewState,
  tabId: string,
  overlay: DesktopPreviewOverlay | null,
): ThreadPreviewState {
  if (isPreviewStateEqual(current.desktopByTabId[tabId] ?? null, overlay)) {
    return current;
  }

  const desktopByTabId = { ...current.desktopByTabId };

  if (overlay) desktopByTabId[tabId] = overlay;
  else delete desktopByTabId[tabId];

  return {
    ...current,
    desktopByTabId,
    desktopOverlay: current.activeTabId === tabId ? overlay : current.desktopOverlay,
  };
}

export function beginPreviewSessionCloseTransition(
  current: ThreadPreviewState,
  tabId: string,
): ThreadPreviewState {
  const suppressedTabIds = new Set(current.suppressedTabIds);
  suppressedTabIds.add(tabId);

  return {
    ...removeSession(current, tabId),
    suppressedTabIds,
  };
}

export function cancelPreviewSessionCloseTransition(
  current: ThreadPreviewState,
  snapshot: PreviewSessionSnapshot | null,
  tabId: string,
): ThreadPreviewState {
  if (!current.suppressedTabIds.has(tabId)) return current;
  const suppressedTabIds = new Set(current.suppressedTabIds);
  suppressedTabIds.delete(tabId);

  if (!snapshot) {
    return { ...current, suppressedTabIds };
  }

  const recentlySeenUrls = !hasTag(snapshot.navStatus, "Idle")
    ? dedupeRecentUrls(current.recentlySeenUrls, snapshot.navStatus.url)
    : current.recentlySeenUrls;

  return {
    ...current,
    snapshot,
    sessions: { ...current.sessions, [snapshot.tabId]: snapshot },
    suppressedTabIds,
    activeTabId: snapshot.tabId,
    desktopOverlay: current.desktopByTabId[snapshot.tabId] ?? null,
    recentlySeenUrls,
  };
}

export function setActivePreviewTabTransition(
  current: ThreadPreviewState,
  tabId: string,
): ThreadPreviewState {
  const snapshot = current.sessions[tabId];

  if (!snapshot || current.activeTabId === tabId) return current;

  return {
    ...current,
    activeTabId: tabId,
    snapshot,
    desktopOverlay: current.desktopByTabId[tabId] ?? null,
  };
}

export function rememberPreviewUrlTransition(
  current: ThreadPreviewState,
  url: string,
): ThreadPreviewState {
  return {
    ...current,
    recentlySeenUrls: dedupeRecentUrls(current.recentlySeenUrls, url),
  };
}
