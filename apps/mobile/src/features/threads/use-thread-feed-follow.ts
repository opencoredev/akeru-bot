import type { LegendListRef } from "@legendapp/list/react-native";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";

import type { ThreadFeedEntry } from "../../lib/threadActivity";
import {
  resolveThreadFeedLiveFollow,
  type ThreadFeedLiveFollowEvent,
} from "./thread-feed-live-follow";

/**
 * Owns the feed's live-follow latch, user scroll sessions, header material
 * visibility, and the brief scroll-maintenance pause around disclosure toggles.
 * ThreadFeed spreads `scrollHandlers` onto the list and enables
 * maintainScrollAtEnd only while `endScrollMaintenanceActive` is true.
 */
export function useThreadFeedFollow(input: {
  readonly listRef: RefObject<LegendListRef | null>;
  /** Scroll offset at which content sits right under the header. */
  readonly anchorTopInset: number;
  /** Environment-scoped thread key; a change re-arms follow. */
  readonly feedThreadKey: string;
  readonly submittedMessageId: string | null;
  readonly onEndFollowEnabledChange: ((enabled: boolean) => void) | undefined;
  readonly onHeaderMaterialVisibilityChange: ((visible: boolean) => void) | undefined;
}) {
  const { listRef, anchorTopInset, feedThreadKey, submittedMessageId } = input;
  const { onEndFollowEnabledChange, onHeaderMaterialVisibilityChange } = input;
  const foldSettleFrameRef = useRef<number | null>(null);
  const foldSettleSecondFrameRef = useRef<number | null>(null);
  const disclosureAnchorKeyRef = useRef<string | null>(null);
  const headerMaterialVisibleRef = useRef(false);
  const userScrollSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [disclosureToggleSettling, setDisclosureToggleSettling] = useState(false);
  // Live-follow latch. LegendList's maintainScrollAtEnd alone re-pins the feed
  // whenever the viewport drifts back inside its geometric threshold, which
  // yanked users off history they were reading every time a stream chunk grew
  // a row. Follow breaks when the user scrolls up and away, and re-arms only
  // when the list actually returns to the end (or on send / thread switch).
  const [endFollowEnabled, setEndFollowEnabled] = useState(true);
  const endFollowEnabledRef = useRef(true);
  // A "user scroll session" spans from drag start through the end of its
  // momentum; only motion inside a session can break follow, so MVCP
  // compensations and programmatic scrolls never strand a follower.
  const userScrollSessionRef = useRef(false);
  const setEndFollow = useCallback(
    (enabled: boolean) => {
      if (endFollowEnabledRef.current === enabled) {
        return;
      }
      endFollowEnabledRef.current = enabled;
      setEndFollowEnabled(enabled);
      onEndFollowEnabledChange?.(enabled);
    },
    [onEndFollowEnabledChange],
  );
  const transitionEndFollow = useCallback(
    (event: ThreadFeedLiveFollowEvent) => {
      setEndFollow(resolveThreadFeedLiveFollow(endFollowEnabledRef.current, event));
    },
    [setEndFollow],
  );
  const reportHeaderMaterialVisibility = useCallback(
    (visible: boolean) => {
      if (headerMaterialVisibleRef.current === visible) {
        return;
      }
      headerMaterialVisibleRef.current = visible;
      onHeaderMaterialVisibilityChange?.(visible);
    },
    [onHeaderMaterialVisibilityChange],
  );
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      // anchorTopInset, not topContentInset: under automatic insets the list
      // rests at contentOffset.y = -headerHeight (the inset lives only in
      // UIKit's adjustedContentInset, so topContentInset is 0 here). Add the
      // header height back or the material toggles a full header too late.
      reportHeaderMaterialVisibility(event.nativeEvent.contentOffset.y + anchorTopInset > 6);
      // LegendList recomputes its inset-aware end distance before invoking
      // this handler, so getState() is current. Only the actual end re-arms
      // follow: its broader maintain-scroll threshold is large enough for a
      // streaming chunk to pull a user back before their upward drag escapes.
      // A live user-scroll session still wins even if the first scroll event
      // remains inside LegendList's at-end tolerance.
      const listState = listRef.current?.getState();
      if (listState) {
        transitionEndFollow({
          type: "scroll",
          isAtEnd: listState.isAtEnd,
          userScrollSessionActive: userScrollSessionRef.current,
        });
      }
    },
    [reportHeaderMaterialVisibility, anchorTopInset, listRef, transitionEndFollow],
  );
  const clearUserScrollSettle = useCallback(() => {
    if (userScrollSettleTimerRef.current !== null) {
      clearTimeout(userScrollSettleTimerRef.current);
      userScrollSettleTimerRef.current = null;
    }
  }, []);
  const onScrollBeginDrag = useCallback(() => {
    clearUserScrollSettle();
    userScrollSessionRef.current = true;
    // Pause before the first scroll event. Otherwise a stream update can run
    // maintainScrollAtEnd between touch-down and the drag leaving its threshold.
    transitionEndFollow({ type: "user-scroll-begin" });
  }, [clearUserScrollSettle, transitionEndFollow]);
  const finishUserScroll = useCallback(
    (releaseIsAtEnd?: boolean) => {
      clearUserScrollSettle();
      const userScrollSessionActive = userScrollSessionRef.current;
      userScrollSessionRef.current = false;
      transitionEndFollow({
        type: "user-scroll-end",
        // With no momentum, preserve the finger-release position. Streaming
        // growth during the native momentum-detection window must not turn a
        // release at the live edge into an opt-out from follow.
        isAtEnd: releaseIsAtEnd ?? listRef.current?.getState().isAtEnd ?? false,
        userScrollSessionActive,
      });
    },
    [clearUserScrollSettle, listRef, transitionEndFollow],
  );
  // Finger-lift velocity is not a reliable momentum signal: a gentle fling
  // can report zero and still decelerate. Give native momentum a short window
  // to announce itself; if it does, onMomentumScrollBegin cancels this fallback
  // and the session survives until the settled momentum-end position. This
  // mirrors the native-event handoff used by the home thread list's scroll gate.
  const onScrollEndDrag = useCallback(() => {
    clearUserScrollSettle();
    const releaseIsAtEnd = listRef.current?.getState().isAtEnd ?? false;
    userScrollSettleTimerRef.current = setTimeout(() => finishUserScroll(releaseIsAtEnd), 160);
  }, [clearUserScrollSettle, finishUserScroll, listRef]);
  const onMomentumScrollBegin = useCallback(() => {
    if (userScrollSessionRef.current) {
      clearUserScrollSettle();
    }
  }, [clearUserScrollSettle]);
  const onMomentumScrollEnd = useCallback(() => {
    finishUserScroll();
  }, [finishUserScroll]);

  useEffect(() => clearUserScrollSettle, [clearUserScrollSettle]);

  useEffect(() => {
    reportHeaderMaterialVisibility(false);
  }, [feedThreadKey, reportHeaderMaterialVisibility]);

  // A thread switch opens pinned to the end; a send explicitly returns to the
  // live edge (ThreadDetailScreen scrolls the new message into place). Both
  // re-arm follow regardless of where the user had scrolled before.
  useEffect(() => {
    clearUserScrollSettle();
    userScrollSessionRef.current = false;
    transitionEndFollow({ type: "reset" });
  }, [clearUserScrollSettle, feedThreadKey, transitionEndFollow]);
  useEffect(() => {
    if (submittedMessageId !== null) {
      clearUserScrollSettle();
      userScrollSessionRef.current = false;
      transitionEndFollow({ type: "reset" });
    }
  }, [clearUserScrollSettle, submittedMessageId, transitionEndFollow]);

  useEffect(() => {
    return () => {
      if (foldSettleFrameRef.current !== null) {
        cancelAnimationFrame(foldSettleFrameRef.current);
      }
      if (foldSettleSecondFrameRef.current !== null) {
        cancelAnimationFrame(foldSettleSecondFrameRef.current);
      }
    };
  }, []);

  const suspendEndScrollMaintenanceForDisclosure = useCallback((anchorKey: string | null) => {
    disclosureAnchorKeyRef.current = anchorKey;
    setDisclosureToggleSettling(true);
    if (foldSettleFrameRef.current !== null) {
      cancelAnimationFrame(foldSettleFrameRef.current);
    }
    if (foldSettleSecondFrameRef.current !== null) {
      cancelAnimationFrame(foldSettleSecondFrameRef.current);
    }
    foldSettleFrameRef.current = requestAnimationFrame(() => {
      foldSettleSecondFrameRef.current = requestAnimationFrame(() => {
        disclosureAnchorKeyRef.current = null;
        setDisclosureToggleSettling(false);
        foldSettleFrameRef.current = null;
        foldSettleSecondFrameRef.current = null;
      });
    });
  }, []);

  const shouldRestoreVisibleContentPosition = useCallback((entry: ThreadFeedEntry) => {
    const disclosureAnchorKey = disclosureAnchorKeyRef.current;
    return disclosureAnchorKey === null || entry.id === disclosureAnchorKey;
  }, []);

  const maintainVisibleContentPosition = useMemo(
    () => ({
      data: true,
      size: true,
      shouldRestorePosition: shouldRestoreVisibleContentPosition,
    }),
    [shouldRestoreVisibleContentPosition],
  );

  return {
    endScrollMaintenanceActive: endFollowEnabled && !disclosureToggleSettling,
    maintainVisibleContentPosition,
    suspendEndScrollMaintenanceForDisclosure,
    scrollHandlers: {
      onScroll,
      onScrollBeginDrag,
      onScrollEndDrag,
      onMomentumScrollBegin,
      onMomentumScrollEnd,
    },
  };
}
