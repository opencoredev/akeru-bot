import { useState } from "react";

/** More new ids than this in one update is history loading, not a live message. */
const LIVE_ARRIVAL_LIMIT = 2;

export interface MessageArrivalScope {
  /** The bot or group the conversation belongs to. */
  readonly owner: string;
  /** The linked thread, or null before the first message creates one. */
  readonly thread: string | null;
}

export interface MessageArrivalState {
  readonly scope: MessageArrivalScope;
  readonly key: string;
  readonly seen: ReadonlySet<string>;
  readonly arrived: ReadonlySet<string>;
}

export function initialMessageArrivals(
  scope: MessageArrivalScope,
  ids: ReadonlyArray<string>,
): MessageArrivalState {
  return { scope, key: ids.join("\n"), seen: new Set(ids), arrived: new Set() };
}

/**
 * Tracks which messages arrived live so only those animate in. History present on
 * mount, loaded in bulk, or shown after switching threads is marked seen without
 * animating. A thread linking to a chat that had none keeps its scope, so the
 * first message of a new chat still animates.
 */
export function reduceMessageArrivals(
  state: MessageArrivalState,
  scope: MessageArrivalScope,
  ids: ReadonlyArray<string>,
): MessageArrivalState {
  const key = ids.join("\n");
  const switched =
    scope.owner !== state.scope.owner ||
    (state.scope.thread !== null && scope.thread !== state.scope.thread);
  if (switched) return initialMessageArrivals(scope, ids);
  if (key === state.key && scope.thread === state.scope.thread) return state;
  const fresh = ids.filter((id) => !state.seen.has(id));
  const seen = new Set(state.seen);
  for (const id of fresh) seen.add(id);
  if (fresh.length === 0 || fresh.length > LIVE_ARRIVAL_LIMIT) {
    return { scope, key, seen, arrived: state.arrived };
  }
  const arrived = new Set(state.arrived);
  for (const id of fresh) arrived.add(id);
  return { scope, key, seen, arrived };
}

/** Ids of messages that arrived live in the current conversation. */
export function useMessageArrivals(
  scope: MessageArrivalScope,
  ids: ReadonlyArray<string>,
): ReadonlySet<string> {
  const [state, setState] = useState(() => initialMessageArrivals(scope, ids));
  const next = reduceMessageArrivals(state, scope, ids);
  if (next !== state) setState(next);
  return next.arrived;
}
