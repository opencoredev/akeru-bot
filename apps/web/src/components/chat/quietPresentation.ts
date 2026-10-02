import {
  workEntryDisplayIndicatesToolFailure,
  workLogEntryIsToolLike,
  type TimelineEntry,
  type WorkLogEntry,
} from "../../session-logic";

/**
 * Quiet presentation hides tool-call chrome so a bot reads like a teammate:
 * messages and plans stay, tool rows disappear, and a failure collapses to
 * one plain status row. Detailed presentation is the full work log.
 */
export type PresentationMode = "quiet" | "detailed";

export const QUIET_FAILURE_LABEL = "A step failed";

/**
 * Strip a failed tool row down to a plain status row: no command, no output,
 * no tool payload. The id is kept so timeline keys stay stable across mode
 * flips and streaming updates.
 */
export function quietFailureEntry(entry: WorkLogEntry): WorkLogEntry {
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    ...(entry.turnId !== undefined ? { turnId: entry.turnId } : {}),
    label: QUIET_FAILURE_LABEL,
    tone: "error",
  };
}

export function applyQuietPresentation(entries: ReadonlyArray<TimelineEntry>): TimelineEntry[] {
  const result: TimelineEntry[] = [];

  for (const item of entries) {
    if (item.kind !== "work") {
      result.push(item);
      continue;
    }

    // Spawn CTA rows stay: they are navigation to child agents, not tool chrome.
    if (item.entry.agentSpawn !== undefined) {
      result.push(item);
      continue;
    }

    if (!workLogEntryIsToolLike(item.entry)) {
      result.push(item);
      continue;
    }

    if (workEntryDisplayIndicatesToolFailure(item.entry)) {
      result.push({ ...item, entry: quietFailureEntry(item.entry) });
    }
    // Successful, neutral, and in-progress tool rows are dropped.
  }

  return result;
}

const DETAILED_STORAGE_PREFIX = "akeru.presentation.detailed:";

function storageOrNull(storage?: Storage): Storage | null {
  if (storage) return storage;

  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Quiet is the product default; storage only records the detailed opt-out. */
export function readStoredPresentationMode(threadKey: string, storage?: Storage): PresentationMode {
  const store = storageOrNull(storage);

  if (!store) return "quiet";

  try {
    return store.getItem(DETAILED_STORAGE_PREFIX + threadKey) === "1" ? "detailed" : "quiet";
  } catch {
    return "quiet";
  }
}

export function storePresentationMode(
  threadKey: string,
  mode: PresentationMode,
  storage?: Storage,
): void {
  const store = storageOrNull(storage);

  if (!store) return;

  try {
    if (mode === "detailed") {
      store.setItem(DETAILED_STORAGE_PREFIX + threadKey, "1");
    } else {
      store.removeItem(DETAILED_STORAGE_PREFIX + threadKey);
    }
  } catch {
    // Storage can be unavailable (private mode, quota); the toggle still
    // works for the session via component state.
  }
}
