export interface DictationIdentity {
  readonly environmentId: string;
  readonly threadId: string;
  readonly draftId: string;
  /** Increment when a draft is sent, cleared, or replaced, not on ordinary edits. */
  readonly generation: number;
}

export interface DictationDraft {
  readonly identity: DictationIdentity;
  readonly text: string;
  readonly selection: { readonly start: number; readonly end: number };
}

export function sameDictationIdentity(left: DictationIdentity, right: DictationIdentity) {
  return (
    left.environmentId === right.environmentId &&
    left.threadId === right.threadId &&
    left.draftId === right.draftId &&
    left.generation === right.generation
  );
}

/** Insert at the original caret only when unchanged; otherwise append without disturbing edits. */
export function mergeDictationDraft(
  original: DictationDraft,
  current: DictationDraft,
  transcript: string,
  maxDraftCharacters: number,
): DictationDraft {
  if (!sameDictationIdentity(original.identity, current.identity)) return current;
  const text = transcript.trim();
  if (!text) return current;
  const unchanged = original.text === current.text;
  let offset = unchanged ? original.selection.end : current.text.length;
  offset = Number.isFinite(offset)
    ? Math.max(0, Math.min(current.text.length, offset))
    : current.text.length;
  offset = Math.trunc(offset);
  const selectionLow = Math.min(current.selection.start, current.selection.end);
  const selectionHigh = Math.max(current.selection.start, current.selection.end);
  if (offset > selectionLow && offset < selectionHigh) offset = current.text.length;
  // Do not split a UTF-16 surrogate pair.
  if (
    offset > 0 &&
    /[\uD800-\uDBFF]/u.test(current.text.charAt(offset - 1)) &&
    /[\uDC00-\uDFFF]/u.test(current.text.charAt(offset))
  )
    offset += 1;
  const before = current.text.slice(0, offset);
  const after = current.text.slice(offset);
  const insertion = `${before && !/\s$/u.test(before) ? " " : ""}${text}${after && !/^\s/u.test(after) ? " " : ""}`;
  if (
    !Number.isSafeInteger(maxDraftCharacters) ||
    maxDraftCharacters < 1 ||
    current.text.length + insertion.length > maxDraftCharacters
  )
    return current;
  const selection = current.selection;
  const collapsed = selection.start === selection.end;
  const shift = (position: number) =>
    position > offset || ((collapsed || selectionLow === offset) && position === offset)
      ? position + insertion.length
      : position;
  return {
    ...current,
    text: before + insertion + after,
    selection: { start: shift(selection.start), end: shift(selection.end) },
  };
}
