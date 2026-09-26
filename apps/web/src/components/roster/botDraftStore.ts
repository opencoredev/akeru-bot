const DRAFTS_KEY = "akeru:bot-drafts:v1";
const MAX_DRAFT_CHARS = 20_000;

function storage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function parseDrafts(raw: string | null): Record<string, string> {
  try {
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

function readAll(): Record<string, string> {
  const localStorage = storage();
  if (!localStorage) return {};
  try {
    return parseDrafts(localStorage.getItem(DRAFTS_KEY));
  } catch {
    return {};
  }
}

function writeAll(drafts: Record<string, string>): void {
  const localStorage = storage();
  if (!localStorage) return;
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    // Quota or private mode. Draft recovery is best-effort.
  }
}

// Keystrokes land here first and reach localStorage after a short pause, on blur, or when
// the page hides. Flushing merges into the stored map so drafts from other tabs survive.
const pendingDrafts = new Map<string, string>();
const FLUSH_DELAY_MS = 400;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let unloadListenersInstalled = false;

/**
 * Another tab wrote drafts. A pending edit older than that write must not overwrite it, so
 * drop pending entries for every key the other tab changed. This keeps last-write-wins, as
 * when every keystroke was written straight to storage.
 */
export function onBotDraftsStorageChange(
  event: Pick<StorageEvent, "key" | "oldValue" | "newValue">,
): void {
  if (event.key !== DRAFTS_KEY && event.key !== null) return;
  if (pendingDrafts.size === 0) return;
  const before = parseDrafts(event.oldValue);
  const after = parseDrafts(event.newValue);
  for (const draftKey of pendingDrafts.keys()) {
    if (before[draftKey] !== after[draftKey] || event.key === null) pendingDrafts.delete(draftKey);
  }
  if (pendingDrafts.size === 0 && flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

function installUnloadListeners(): void {
  if (unloadListenersInstalled || typeof window === "undefined") return;
  unloadListenersInstalled = true;
  window.addEventListener("storage", onBotDraftsStorageChange);
  window.addEventListener("pagehide", flushBotDrafts);
  window.addEventListener("beforeunload", flushBotDrafts);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushBotDrafts();
  });
}

/** Writes pending drafts to storage now. Safe to call when nothing is pending. */
export function flushBotDrafts(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingDrafts.size === 0) return;
  const drafts = readAll();
  for (const [draftKey, text] of pendingDrafts) {
    if (text.length === 0) delete drafts[draftKey];
    else drafts[draftKey] = text;
  }
  pendingDrafts.clear();
  writeAll(drafts);
}

export function readBotDraft(draftKey: string): string {
  return pendingDrafts.get(draftKey) ?? readAll()[draftKey] ?? "";
}

/** Records a draft in memory and persists it after typing pauses. */
export function writeBotDraft(draftKey: string, text: string): void {
  pendingDrafts.set(draftKey, text.slice(0, MAX_DRAFT_CHARS));
  installUnloadListeners();
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = setTimeout(flushBotDrafts, FLUSH_DELAY_MS);
}

/** Clears a draft and persists the removal immediately. */
export function clearBotDraft(draftKey: string): void {
  pendingDrafts.set(draftKey, "");
  flushBotDrafts();
}
