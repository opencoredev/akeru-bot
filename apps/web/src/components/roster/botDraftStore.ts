const DRAFTS_KEY = "akeru:bot-drafts:v1";
const MAX_DRAFT_CHARS = 20_000;

function storage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function readAll(): Record<string, string> {
  const localStorage = storage();
  if (!localStorage) return {};
  try {
    const raw = localStorage.getItem(DRAFTS_KEY);
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

function writeAll(drafts: Record<string, string>): void {
  const localStorage = storage();
  if (!localStorage) return;
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    // Quota or private mode. Draft recovery is best-effort.
  }
}

export function readBotDraft(draftKey: string): string {
  return readAll()[draftKey] ?? "";
}

export function writeBotDraft(draftKey: string, text: string): void {
  const drafts = readAll();
  const clipped = text.slice(0, MAX_DRAFT_CHARS);
  if (clipped.length === 0) {
    delete drafts[draftKey];
  } else {
    drafts[draftKey] = clipped;
  }
  writeAll(drafts);
}

export function clearBotDraft(draftKey: string): void {
  writeBotDraft(draftKey, "");
}
