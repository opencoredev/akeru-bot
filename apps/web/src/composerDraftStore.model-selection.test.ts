import { scopeThreadRef } from "@akeru/client-runtime/environment";
import { ThreadId } from "@akeru/contracts";
import { createModelSelection } from "@akeru/shared/model";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { useComposerDraftStore } from "./composerDraftStore";
import {
  TEST_ENVIRONMENT_ID,
  resetComposerDraftStore,
  modelSelection,
  CODEX_DRIVER,
  draftFor,
  CODEX_INSTANCE,
  CLAUDE_AGENT_DRIVER,
  toSelections,
  CLAUDE_AGENT_INSTANCE,
  CURSOR_DRIVER,
  CURSOR_INSTANCE,
  providerModelOptions,
  CODEX_SECONDARY_INSTANCE,
} from "./composerDraftStore.test-support";

describe("composerDraftStore modelSelection", () => {
  const threadId = ThreadId.make("thread-model-options");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("stores a model selection in the draft", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(
      threadRef,
      modelSelection(CODEX_DRIVER, "gpt-5.3-codex", {
        reasoningEffort: "xhigh",
        fastMode: true,
      }),
    );

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CODEX_INSTANCE],
    ).toEqual(
      modelSelection(CODEX_DRIVER, "gpt-5.3-codex", {
        reasoningEffort: "xhigh",
        fastMode: true,
      }),
    );
  });

  it("keeps default-only model selections on the draft", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(threadRef, modelSelection(CODEX_DRIVER, "gpt-5.4"));

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CODEX_INSTANCE],
    ).toEqual(modelSelection(CODEX_DRIVER, "gpt-5.4"));
  });

  it("replaces only the targeted provider options on the current model selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(
      threadRef,
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", {
        effort: "max",
        fastMode: true,
      }),
    );
    store.setStickyModelSelection(
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", {
        effort: "max",
        fastMode: true,
      }),
    );

    store.setProviderModelOptions(
      threadRef,
      CLAUDE_AGENT_DRIVER,
      toSelections({ thinking: false }),
      {
        persistSticky: true,
      },
    );

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CLAUDE_AGENT_INSTANCE],
    ).toEqual(
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", {
        thinking: false,
      }),
    );
    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider[CLAUDE_AGENT_INSTANCE],
    ).toEqual(
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", {
        thinking: false,
      }),
    );
  });

  it("keeps explicit default-state overrides on the selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(
      threadRef,
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", {
        effort: "max",
      }),
    );

    store.setProviderModelOptions(threadRef, CLAUDE_AGENT_DRIVER, toSelections({ thinking: true }));

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CLAUDE_AGENT_INSTANCE],
    ).toEqual(
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", {
        thinking: true,
      }),
    );
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider).toEqual({});
  });

  it("keeps explicit off/default codex overrides on the selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(threadRef, modelSelection(CODEX_DRIVER, "gpt-5.4", { fastMode: true }));

    store.setProviderModelOptions(
      threadRef,
      CODEX_DRIVER,
      toSelections({ reasoningEffort: "high", fastMode: false }),
    );

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CODEX_INSTANCE],
    ).toEqual(
      modelSelection(CODEX_DRIVER, "gpt-5.4", {
        reasoningEffort: "high",
        fastMode: false,
      }),
    );
  });

  it("keeps explicit Cursor reset overrides on the selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(
      threadRef,
      modelSelection(CURSOR_DRIVER, "claude-opus-4-6", {
        reasoning: "xhigh",
        fastMode: true,
        thinking: false,
      }),
    );

    store.setProviderModelOptions(
      threadRef,
      CURSOR_DRIVER,
      toSelections({ reasoning: "medium", fastMode: false, thinking: true }),
    );

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CURSOR_INSTANCE],
    ).toEqual(
      modelSelection(CURSOR_DRIVER, "claude-opus-4-6", {
        reasoning: "medium",
        fastMode: false,
        thinking: true,
      }),
    );
  });

  it("preserves the selected Cursor model when only traits change", () => {
    const store = useComposerDraftStore.getState();

    store.setProviderModelOptions(threadRef, CURSOR_DRIVER, toSelections({ reasoning: "high" }), {
      model: "gpt-5.4",
      persistSticky: true,
    });

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CURSOR_INSTANCE],
    ).toEqual(
      modelSelection(CURSOR_DRIVER, "gpt-5.4", {
        reasoning: "high",
      }),
    );
    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider[CURSOR_INSTANCE],
    ).toEqual(
      modelSelection(CURSOR_DRIVER, "gpt-5.4", {
        reasoning: "high",
      }),
    );
  });

  it("updates only the draft when sticky persistence is omitted", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", { effort: "max" }),
    );
    store.setModelSelection(
      threadRef,
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", { effort: "max" }),
    );

    store.setProviderModelOptions(
      threadRef,
      CLAUDE_AGENT_DRIVER,
      toSelections({ thinking: false }),
    );

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CLAUDE_AGENT_INSTANCE],
    ).toEqual(
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", {
        thinking: false,
      }),
    );
    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider[CLAUDE_AGENT_INSTANCE],
    ).toEqual(modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", { effort: "max" }));
  });

  it("does not clear other provider options when setting options for a single provider", () => {
    const store = useComposerDraftStore.getState();

    // Set options for both providers
    store.setModelOptions(
      threadRef,
      providerModelOptions({
        codex: { fastMode: true },
        claudeAgent: { effort: "max" },
      }),
    );

    // Now set options for only codex — claudeAgent should be untouched
    store.setModelOptions(threadRef, providerModelOptions({ codex: { reasoningEffort: "xhigh" } }));

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft?.modelSelectionByProvider[CODEX_INSTANCE]?.options).toEqual(
      createModelSelection(CODEX_INSTANCE, "gpt-5.4", toSelections({ reasoningEffort: "xhigh" }))
        .options,
    );
    expect(draft?.modelSelectionByProvider[CLAUDE_AGENT_INSTANCE]?.options).toEqual(
      createModelSelection(
        CLAUDE_AGENT_INSTANCE,
        "claude-opus-4-6",
        toSelections({ effort: "max" }),
      ).options,
    );
  });

  it("preserves other provider options when switching the active model selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelOptions(
      threadRef,
      providerModelOptions({
        codex: { fastMode: true },
        claudeAgent: { effort: "max" },
      }),
    );

    store.setModelSelection(threadRef, modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6"));

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft?.modelSelectionByProvider[CLAUDE_AGENT_INSTANCE]).toEqual(
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", { effort: "max" }),
    );
    expect(draft?.modelSelectionByProvider[CODEX_INSTANCE]?.options).toEqual(
      createModelSelection(CODEX_INSTANCE, "gpt-5.4", toSelections({ fastMode: true })).options,
    );
    expect(draft?.activeProvider).toBe("claudeAgent");
  });

  it("creates the first sticky snapshot from provider option changes", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(threadRef, modelSelection(CODEX_DRIVER, "gpt-5.4"));

    store.setProviderModelOptions(threadRef, CODEX_DRIVER, toSelections({ fastMode: true }), {
      persistSticky: true,
    });

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider[CODEX_INSTANCE]).toEqual(
      modelSelection(CODEX_DRIVER, "gpt-5.4", {
        fastMode: true,
      }),
    );
  });

  it("stores provider option changes on a selected custom instance", () => {
    const store = useComposerDraftStore.getState();

    store.setProviderModelOptions(
      threadRef,
      CODEX_DRIVER,
      toSelections({ reasoningEffort: "low" }),
      {
        instanceId: CODEX_SECONDARY_INSTANCE,
        model: "gpt-5-codex",
        persistSticky: true,
      },
    );

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CODEX_SECONDARY_INSTANCE],
    ).toEqual(
      expect.objectContaining({
        instanceId: CODEX_SECONDARY_INSTANCE,
        options: [{ id: "reasoningEffort", value: "low" }],
      }),
    );
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.activeProvider).toBe(CODEX_SECONDARY_INSTANCE);
    expect(useComposerDraftStore.getState().stickyActiveProvider).toBe(CODEX_SECONDARY_INSTANCE);
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider[CODEX_INSTANCE]).toBe(
      undefined,
    );
    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider[CODEX_SECONDARY_INSTANCE],
    ).toEqual(
      expect.objectContaining({
        instanceId: CODEX_SECONDARY_INSTANCE,
        options: [{ id: "reasoningEffort", value: "low" }],
      }),
    );
  });

  it("updates only the draft when sticky persistence is disabled", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", { effort: "max" }),
    );
    store.setModelSelection(
      threadRef,
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", { effort: "max" }),
    );

    store.setProviderModelOptions(
      threadRef,
      CLAUDE_AGENT_DRIVER,
      toSelections({ thinking: false }),
      {
        persistSticky: false,
      },
    );

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CLAUDE_AGENT_INSTANCE],
    ).toEqual(
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", {
        thinking: false,
      }),
    );
    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider[CLAUDE_AGENT_INSTANCE],
    ).toEqual(modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", { effort: "max" }));
  });
});

describe("composerDraftStore setModelSelection", () => {
  const threadId = ThreadId.make("thread-model");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("keeps explicit model overrides instead of coercing to null", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(threadRef, modelSelection(CODEX_DRIVER, "gpt-5.3-codex"));

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CODEX_INSTANCE],
    ).toEqual(modelSelection(CODEX_DRIVER, "gpt-5.3-codex"));
  });
});

describe("composerDraftStore sticky composer settings", () => {
  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("stores a sticky model selection", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(
      modelSelection(CODEX_DRIVER, "gpt-5.3-codex", {
        reasoningEffort: "medium",
        fastMode: true,
      }),
    );

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider[CODEX_INSTANCE]).toEqual(
      modelSelection(CODEX_DRIVER, "gpt-5.3-codex", {
        reasoningEffort: "medium",
        fastMode: true,
      }),
    );
    expect(useComposerDraftStore.getState().stickyActiveProvider).toBe("codex");
  });

  it("normalizes empty sticky model options by dropping selection options", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(modelSelection(CODEX_DRIVER, "gpt-5.4"));

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider[CODEX_INSTANCE]).toEqual(
      modelSelection(CODEX_DRIVER, "gpt-5.4"),
    );
    expect(useComposerDraftStore.getState().stickyActiveProvider).toBe("codex");
  });

  it("drops empty cursor model options when normalizing sticky state", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(
      modelSelection(CURSOR_DRIVER, "gpt-5.4", {
        reasoning: undefined,
        fastMode: undefined,
        thinking: undefined,
        contextWindow: undefined,
      }),
    );

    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider[CURSOR_INSTANCE],
    ).toEqual(modelSelection(CURSOR_DRIVER, "gpt-5.4"));
    expect(useComposerDraftStore.getState().stickyActiveProvider).toBe("cursor");
  });

  it("applies sticky activeProvider to new drafts", () => {
    const store = useComposerDraftStore.getState();
    const threadId = ThreadId.make("thread-sticky-active-provider");
    const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);

    store.setStickyModelSelection(modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6"));
    store.applyStickyState(threadRef);

    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toMatchObject({
      modelSelectionByProvider: {
        claudeAgent: modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6"),
      },
      activeProvider: "claudeAgent",
    });
  });
});

describe("composerDraftStore provider-scoped option updates", () => {
  const threadId = ThreadId.make("thread-provider");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("retains off-provider option memory without changing the active selection", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(
      threadRef,
      modelSelection(CODEX_DRIVER, "gpt-5.3-codex", {
        reasoningEffort: "medium",
      }),
    );
    store.setProviderModelOptions(threadRef, CLAUDE_AGENT_DRIVER, toSelections({ effort: "max" }));
    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft?.modelSelectionByProvider[CODEX_INSTANCE]).toEqual(
      modelSelection(CODEX_DRIVER, "gpt-5.3-codex", { reasoningEffort: "medium" }),
    );
    expect(draft?.modelSelectionByProvider[CLAUDE_AGENT_INSTANCE]?.options).toEqual(
      createModelSelection(
        CLAUDE_AGENT_INSTANCE,
        "claude-opus-4-6",
        toSelections({ effort: "max" }),
      ).options,
    );
    expect(draft?.activeProvider).toBe("codex");
  });
});

describe("composerDraftStore runtime and interaction settings", () => {
  const threadId = ThreadId.make("thread-settings");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("stores runtime mode overrides in the composer draft", () => {
    const store = useComposerDraftStore.getState();

    store.setRuntimeMode(threadRef, "approval-required");

    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.runtimeMode).toBe("approval-required");
  });

  it("removes empty settings-only drafts when overrides are cleared", () => {
    const store = useComposerDraftStore.getState();

    store.setRuntimeMode(threadRef, "approval-required");
    store.setRuntimeMode(threadRef, null);

    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toBeUndefined();
  });
});
