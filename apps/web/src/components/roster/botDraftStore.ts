const DRAFTS_KEY = "akeru:bot-drafts:v1";
// Per-draft time of the last persisted edit or clear. A delayed flush from another tab
// compares against it so an older edit never overwrites a newer write or clear.
const EDITED_AT_KEY = "akeru:bot-drafts:v1:edited-at";
const MAX_DRAFT_CHARS = 20_000;
// Clear markers only need to outlive other tabs' pending flushes.
const CLEAR_MARKER_TTL_MS = 24 * 60 * 60 * 1000;

function storage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function readRecord<T extends string | number>(
  key: string,
  kind: "string" | "number",
): Record<string, T> {
  const localStorage = storage();
  if (!localStorage) return {};
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, T] => typeof entry[1] === kind),
    );
  } catch {
    return {};
  }
}

function writeRecord(key: string, record: Record<string, string | number>): void {
  const localStorage = storage();
  if (!localStorage) return;
  try {
    localStorage.setItem(key, JSON.stringify(record));
  } catch {
    // Quota or private mode. Draft recovery is best-effort.
  }
}

function readAll(): Record<string, string> {
  return readRecord<string>(DRAFTS_KEY, "string");
}

// Keystrokes land here first and reach localStorage after a short pause, on blur, or when
// the page hides. Flushing merges into the stored map so drafts from other tabs survive.
const pendingDrafts = new Map<string, { readonly text: string; readonly editedAt: number }>();
const FLUSH_DELAY_MS = 400;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let unloadListenersInstalled = false;

function installUnloadListeners(): void {
  if (unloadListenersInstalled || typeof window === "undefined") return;
  unloadListenersInstalled = true;
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
  const editedAt = readRecord<number>(EDITED_AT_KEY, "number");
  for (const [draftKey, pending] of pendingDrafts) {
    // Another tab wrote or cleared this draft after the pending edit was made.
    if ((editedAt[draftKey] ?? 0) > pending.editedAt) continue;
    editedAt[draftKey] = pending.editedAt;
    if (pending.text.length === 0) delete drafts[draftKey];
    else drafts[draftKey] = pending.text;
  }
  pendingDrafts.clear();
  const staleBefore = Date.now() - CLEAR_MARKER_TTL_MS;
  for (const [draftKey, at] of Object.entries(editedAt)) {
    if (drafts[draftKey] === undefined && at < staleBefore) delete editedAt[draftKey];
  }
  writeRecord(DRAFTS_KEY, drafts);
  writeRecord(EDITED_AT_KEY, editedAt);
}

export function readBotDraft(draftKey: string): string {
  return pendingDrafts.get(draftKey)?.text ?? readAll()[draftKey] ?? "";
}

/** Records a draft in memory and persists it after typing pauses. */
export function writeBotDraft(draftKey: string, text: string): void {
  pendingDrafts.set(draftKey, { text: text.slice(0, MAX_DRAFT_CHARS), editedAt: Date.now() });
  installUnloadListeners();
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = setTimeout(flushBotDrafts, FLUSH_DELAY_MS);
}

/** Clears a draft and persists the removal immediately. */
export function clearBotDraft(draftKey: string): void {
  pendingDrafts.set(draftKey, { text: "", editedAt: Date.now() });
  flushBotDrafts();
}
