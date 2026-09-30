import { describe, expect, it } from "vite-plus/test";

import { mergeDictationDraft, type DictationDraft } from "./draft.ts";

const original: DictationDraft = {
  identity: { environmentId: "local", threadId: "thread", draftId: "draft", generation: 1 },
  text: "hello world",
  selection: { start: 0, end: 5 },
};

const merge = (current: DictationDraft, transcript = "new words", limit = 1000) =>
  mergeDictationDraft(original, current, transcript, limit);

describe("dictation draft insertion", () => {
  it("inserts after a selection without replacing or expanding it", () => {
    expect(merge(original)).toEqual({ ...original, text: "hello new words world" });
  });

  it("preserves concurrent edits and the selected text", () => {
    const current = { ...original, text: "edited hello world", selection: { start: 7, end: 12 } };
    expect(merge(current)).toEqual({ ...current, text: "edited hello world new words" });
  });

  it("preserves a moved selection starting at the insertion point", () => {
    const current = { ...original, selection: { start: 5, end: 11 } };
    const result = merge(current);
    expect(result.text.slice(result.selection.start, result.selection.end)).toBe(" world");
  });

  it("appends when the insertion point would split a moved selection", () => {
    const current = { ...original, selection: { start: 2, end: 9 } };
    expect(merge(current)).toEqual({ ...current, text: "hello world new words" });
  });

  it("advances the unchanged caret and preserves whitespace", () => {
    const draft = { ...original, text: "hello ", selection: { start: 6, end: 6 } };
    expect(mergeDictationDraft(draft, draft, "  world  ", 100)).toEqual({
      ...draft,
      text: "hello world",
      selection: { start: 11, end: 11 },
    });
  });

  it.each(["environmentId", "threadId", "draftId", "generation"] as const)(
    "rejects stale %s",
    (key) => {
      const current = {
        ...original,
        identity: { ...original.identity, [key]: key === "generation" ? 2 : "other" },
      };
      expect(merge(current)).toBe(current);
    },
  );

  it("does not erase text for empty output or overflow", () => {
    expect(merge(original, " \n ")).toBe(original);
    expect(merge(original, "words", 12)).toBe(original);
  });

  it("keeps serialized mentions and attachment state when appending after concurrent edits", () => {
    const text = "Keep [@file](file:///project/file.ts) and my edit";
    const attachments = [{ id: "image-1", name: "fixture.png" }];
    const current = {
      ...original,
      text,
      selection: { start: 5, end: 36 },
      attachments,
    };
    const result = mergeDictationDraft(original, current, "spoken words", 1000);
    expect(result.text).toBe(`${text} spoken words`);
    expect(result.selection).toEqual(current.selection);
    expect(result).toMatchObject({ attachments });
    expect(Reflect.get(result, "attachments")).toBe(attachments);
  });

  it("does not split emoji at a malformed caret", () => {
    const draft = { ...original, text: "😀", selection: { start: 1, end: 1 } };
    expect(mergeDictationDraft(draft, draft, "hi", 100).text).toBe("😀 hi");
  });
});
