import { describe, expect, it } from "vite-plus/test";
import { normalizeCurrentPersistedComposerDraftStoreState } from "./draftPersistence";

const codexSelection = {
  instanceId: "codex",
  model: "gpt-5.4",
};

const invalidSelections = [
  { provider: "claudeAgent", model: "claude-opus-4-6", options: [{ id: "effort", value: 42 }] },
  { provider: "claudeAgent", model: "" },
];

describe("persisted composer provider selection recovery", () => {
  it.each(invalidSelections)("retains valid draft selections beside %j", (invalidSelection) => {
    const normalized = normalizeCurrentPersistedComposerDraftStoreState({
      draftsByThreadKey: {
        thread: {
          modelSelectionByProvider: { codex: codexSelection, claudeAgent: invalidSelection },
          activeProvider: "codex",
        },
      },
    });

    expect(normalized.draftsByThreadKey.thread?.modelSelectionByProvider).toEqual({
      codex: codexSelection,
    });
    expect(normalized.draftsByThreadKey.thread?.activeProvider).toBe("codex");
  });

  it.each(invalidSelections)("retains valid sticky selections beside %j", (invalidSelection) => {
    const normalized = normalizeCurrentPersistedComposerDraftStoreState({
      stickyModelSelectionByProvider: { codex: codexSelection, claudeAgent: invalidSelection },
      stickyActiveProvider: "codex",
    });

    expect(normalized.stickyModelSelectionByProvider).toEqual({ codex: codexSelection });
    expect(normalized.stickyActiveProvider).toBe("codex");
  });

  it("ignores invalid provider keys without discarding valid selections", () => {
    const selections = { codex: codexSelection, "invalid key": codexSelection };

    const normalized = normalizeCurrentPersistedComposerDraftStoreState({
      draftsByThreadKey: {
        thread: { modelSelectionByProvider: selections, activeProvider: "codex" },
      },
      stickyModelSelectionByProvider: selections,
      stickyActiveProvider: "codex",
    });

    expect(normalized.draftsByThreadKey.thread?.modelSelectionByProvider).toEqual({
      codex: codexSelection,
    });
    expect(normalized.draftsByThreadKey.thread?.activeProvider).toBe("codex");
    expect(normalized.stickyModelSelectionByProvider).toEqual({ codex: codexSelection });
    expect(normalized.stickyActiveProvider).toBe("codex");
  });
});
