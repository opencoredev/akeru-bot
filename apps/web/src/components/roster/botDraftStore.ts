const DRAFTS_KEY = "akeru:bot-drafts:v1";
// Which write each stored draft came from. `seq` only grows, so a version is never reused.
// A pending edit remembers the version it saw when typed; a flush writes it only if storage
// still holds that version, so an older edit never overwrites another tab's newer write or clear.
const VERSIONS_KEY = "akeru:bot-drafts:v1:versions";
const MAX_DRAFT_CHARS = 20_000;

function storage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function readJson(key: string): Record<string, unknown> {
  const localStorage = storage();
  if (!localStorage) return {};
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeJson(key: string, value: unknown): void {
  const localStorage = storage();
  if (!localStorage) return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or private mode. Draft recovery is best-effort.
  }
}

function readAll(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(readJson(DRAFTS_KEY)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

interface DraftVersions {
  seq: number;
  versions: Record<string, number>;
}

function readVersions(): DraftVersions {
  const stored = readJson(VERSIONS_KEY);
  const versions =
    typeof stored.versions === "object" && stored.versions !== null ? stored.versions : {};
  return {
    seq: typeof stored.seq === "number" ? stored.seq : 0,
    versions: Object.fromEntries(
      Object.entries(versions).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number",
      ),
    ),
  };
}

// Keystrokes land here first and reach localStorage after a short pause, on blur, or when
// the page hides. Flushing merges into the stored map so drafts from other tabs survive.
const pendingDrafts = new Map<
  string,
  { readonly text: string; readonly seenVersion: number | undefined }
>();
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
  const stored = readVersions();
  for (const [draftKey, pending] of pendingDrafts) {
    // Another tab wrote or cleared this draft after the pending edit was typed.
    if (stored.versions[draftKey] !== pending.seenVersion) continue;
    if (pending.text.length === 0) {
      delete drafts[draftKey];
      delete stored.versions[draftKey];
    } else {
      drafts[draftKey] = pending.text;
      stored.seq += 1;
      stored.versions[draftKey] = stored.seq;
    }
  }
  pendingDrafts.clear();
  writeJson(DRAFTS_KEY, drafts);
  writeJson(VERSIONS_KEY, stored);
}

export function readBotDraft(draftKey: string): string {
  return pendingDrafts.get(draftKey)?.text ?? readAll()[draftKey] ?? "";
}

/** Records a draft in memory and persists it after typing pauses. */
export function writeBotDraft(draftKey: string, text: string): void {
  pendingDrafts.set(draftKey, {
    text: text.slice(0, MAX_DRAFT_CHARS),
    seenVersion: readVersions().versions[draftKey],
  });
  installUnloadListeners();
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = setTimeout(flushBotDrafts, FLUSH_DELAY_MS);
}

/** Clears a draft and persists the removal immediately. */
export function clearBotDraft(draftKey: string): void {
  pendingDrafts.set(draftKey, { text: "", seenVersion: readVersions().versions[draftKey] });
  flushBotDrafts();
}
