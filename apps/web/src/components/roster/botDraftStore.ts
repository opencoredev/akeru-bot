// Each draft lives under its own key and is written as it is typed, so a keystroke costs one
// small write instead of rewriting every draft, and the last write across tabs wins.
const DRAFT_KEY_PREFIX = "akeru:bot-draft:v2:";
// Drafts saved before per-draft keys, moved over once per page load.
const LEGACY_DRAFTS_KEY = "akeru:bot-drafts:v1";
const MAX_DRAFT_CHARS = 20_000;

function storage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

let legacyMigrated = false;

function migrateLegacyDrafts(localStorage: Storage): void {
  if (legacyMigrated) return;
  legacyMigrated = true;
  try {
    const raw = localStorage.getItem(LEGACY_DRAFTS_KEY);
    if (raw === null) return;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      for (const [draftKey, text] of Object.entries(parsed)) {
        const key = DRAFT_KEY_PREFIX + draftKey;
        if (typeof text === "string" && text.length > 0 && localStorage.getItem(key) === null) {
          localStorage.setItem(key, text.slice(0, MAX_DRAFT_CHARS));
        }
      }
    }
    localStorage.removeItem(LEGACY_DRAFTS_KEY);
  } catch {
    // Unreadable legacy drafts are dropped. Draft recovery is best-effort.
  }
}

function draftStorage(): Storage | null {
  const localStorage = storage();
  if (localStorage) migrateLegacyDrafts(localStorage);
  return localStorage;
}

export function readBotDraft(draftKey: string): string {
  try {
    return draftStorage()?.getItem(DRAFT_KEY_PREFIX + draftKey) ?? "";
  } catch {
    return "";
  }
}

export function writeBotDraft(draftKey: string, text: string): void {
  const localStorage = draftStorage();
  if (!localStorage) return;
  const clipped = text.slice(0, MAX_DRAFT_CHARS);
  try {
    if (clipped.length === 0) localStorage.removeItem(DRAFT_KEY_PREFIX + draftKey);
    else localStorage.setItem(DRAFT_KEY_PREFIX + draftKey, clipped);
  } catch {
    // Quota or private mode. Draft recovery is best-effort.
  }
}

export function clearBotDraft(draftKey: string): void {
  writeBotDraft(draftKey, "");
}

/** Resets the once-per-page legacy migration. Tests only. */
export function resetBotDraftMigrationForTests(): void {
  legacyMigrated = false;
}
