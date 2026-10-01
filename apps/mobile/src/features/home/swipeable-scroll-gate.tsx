import { createContext, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";

/**
 * Delivers the scroll gate to swipeables via context so that flipping it does
 * NOT re-render whole rows: putting the flag in list extraData/renderItem deps
 * re-rendered every visible row (hooks, subscriptions and all) exactly at
 * scroll start — peak frame pressure. As a context value only the
 * ThreadSwipeable consumers re-render.
 */
export const SwipeableScrollGateContext = createContext(true);

export function SwipeableScrollGateProvider(props: {
  readonly enabled: boolean;
  readonly children: ReactNode;
}) {
  return (
    <SwipeableScrollGateContext.Provider value={props.enabled}>
      {props.children}
    </SwipeableScrollGateContext.Provider>
  );
}

/**
 * Gates row swipes on list scroll activity, mirroring UIKit's own swipe
 * actions (`!isDragging && !isDecelerating`). failOffsetY on the swipe pan
 * covers the first pan of a scroll, but trackpad scroll sessions spawn fresh
 * gesture sessions (momentum catch, direction changes) whose reset
 * translation can re-activate a swipe mid-scroll — so while the list has
 * moved vertically during an active drag/momentum phase, row swipes are
 * disabled entirely.
 *
 * Spread the returned handlers onto the list and pass `swipeEnabled` to rows.
 */
export function useSwipeableScrollGate(options?: {
  readonly onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  readonly onScrollBeginDrag?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
}) {
  const [gateActive, setGateActive] = useState(false);
  const gateActiveRef = useRef(false);
  const draggingRef = useRef(false);
  const dragStartYRef = useRef(0);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const externalOnScroll = options?.onScroll;
  const externalOnScrollBeginDrag = options?.onScrollBeginDrag;

  const update = useCallback((next: boolean) => {
    if (gateActiveRef.current !== next) {
      gateActiveRef.current = next;
      setGateActive(next);
    }
  }, []);
  const clearSettle = useCallback(() => {
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);
  useEffect(() => clearSettle, [clearSettle]);

  const onScrollBeginDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      draggingRef.current = true;
      dragStartYRef.current = event.nativeEvent.contentOffset.y;
      clearSettle();
      externalOnScrollBeginDrag?.(event);
    },
    [clearSettle, externalOnScrollBeginDrag],
  );
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      // Only vertical movement during a user drag arms the gate — a purely
      // horizontal row swipe never moves contentOffset.y, and inset-driven
      // offset changes at mount happen outside a drag.
      if (
        draggingRef.current &&
        !gateActiveRef.current &&
        Math.abs(event.nativeEvent.contentOffset.y - dragStartYRef.current) > 4
      ) {
        update(true);
      }
      externalOnScroll?.(event);
    },
    [externalOnScroll, update],
  );
  const onScrollEndDrag = useCallback(() => {
    draggingRef.current = false;
    clearSettle();
    // If momentum follows, onMomentumScrollBegin cancels this and the gate
    // stays armed until the deceleration finishes.
    settleTimerRef.current = setTimeout(() => update(false), 160);
  }, [clearSettle, update]);
  const onMomentumScrollBegin = useCallback(() => {
    clearSettle();
  }, [clearSettle]);
  const onMomentumScrollEnd = useCallback(() => {
    update(false);
  }, [update]);

  return {
    swipeEnabled: !gateActive,
    scrollGateHandlers: {
      onScroll,
      onScrollBeginDrag,
      onScrollEndDrag,
      onMomentumScrollBegin,
      onMomentumScrollEnd,
    },
  };
}
