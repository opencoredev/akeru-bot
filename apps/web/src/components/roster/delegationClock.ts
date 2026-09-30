import { useSyncExternalStore } from "react";

const TICK_MS = 1_000;

const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const subscribeIdle = () => () => {};
// Before the first tick, read the wall clock at second resolution so repeated
// snapshot reads within one render agree.
const getNow = () => (timer === null ? Math.floor(Date.now() / TICK_MS) * TICK_MS : now);
const getIdle = () => 0;

/**
 * Current time for live work cards. Every live card shares one interval, which
 * runs only while at least one live card is mounted. Finished cards pass
 * `live: false`, never subscribe, and read 0 because their end time is fixed.
 */
export function useDelegationClock(live: boolean): number {
  return useSyncExternalStore(
    live ? subscribe : subscribeIdle,
    live ? getNow : getIdle,
    live ? getNow : getIdle,
  );
}

/** Test inspection: live subscribers and whether the shared interval is running. */
export function delegationClockState(): {
  readonly subscribers: number;
  readonly ticking: boolean;
} {
  return { subscribers: listeners.size, ticking: timer !== null };
}

export const delegationClockForTesting = { subscribe };
