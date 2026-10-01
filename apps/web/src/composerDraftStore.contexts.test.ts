import { scopeThreadRef } from "@akeru/client-runtime/environment";
import { ThreadId } from "@akeru/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { useComposerDraftStore } from "./composerDraftStore";
import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  insertInlineTerminalContextPlaceholder,
} from "./lib/terminalContext";
import {
  TEST_ENVIRONMENT_ID,
  makeTerminalContext,
  draftFor,
  threadKeyFor,
  resetComposerDraftStore,
} from "./composerDraftStore.test-support";

describe("composerDraftStore terminal contexts", () => {
  const threadId = ThreadId.make("thread-dedupe");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);

  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
  });

  it("deduplicates identical terminal contexts by selection signature", () => {
    const first = makeTerminalContext({ id: "ctx-1" });
    const duplicate = makeTerminalContext({ id: "ctx-2" });

    useComposerDraftStore.getState().addTerminalContexts(threadRef, [first, duplicate]);

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft?.terminalContexts.map((context) => context.id)).toEqual(["ctx-1"]);
  });

  it("clears terminal contexts when clearing composer content", () => {
    useComposerDraftStore
      .getState()
      .addTerminalContext(threadRef, makeTerminalContext({ id: "ctx-1" }));

    useComposerDraftStore.getState().clearComposerContent(threadRef);

    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toBeUndefined();
  });

  it("inserts terminal contexts at the requested inline prompt position", () => {
    const firstInsertion = insertInlineTerminalContextPlaceholder("alpha beta", 6);
    const secondInsertion = insertInlineTerminalContextPlaceholder(firstInsertion.prompt, 0);

    expect(
      useComposerDraftStore
        .getState()
        .insertTerminalContext(
          threadRef,
          firstInsertion.prompt,
          makeTerminalContext({ id: "ctx-1" }),
          firstInsertion.contextIndex,
        ),
    ).toBe(true);
    expect(
      useComposerDraftStore.getState().insertTerminalContext(
        threadRef,
        secondInsertion.prompt,
        makeTerminalContext({
          id: "ctx-2",
          terminalLabel: "Terminal 2",
          lineStart: 9,
          lineEnd: 10,
        }),
        secondInsertion.contextIndex,
      ),
    ).toBe(true);

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft?.prompt).toBe(
      `${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} alpha ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} beta`,
    );
    expect(draft?.terminalContexts.map((context) => context.id)).toEqual(["ctx-2", "ctx-1"]);
  });

  it("omits terminal context text from persisted drafts", () => {
    useComposerDraftStore
      .getState()
      .addTerminalContext(threadRef, makeTerminalContext({ id: "ctx-persist" }));

    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown;
      };
    };

    const persistedState = persistApi.getOptions().partialize(useComposerDraftStore.getState()) as {
      draftsByThreadKey?: Record<string, { terminalContexts?: Array<Record<string, unknown>> }>;
    };

    expect(
      persistedState.draftsByThreadKey?.[threadKeyFor(threadId, TEST_ENVIRONMENT_ID)]
        ?.terminalContexts?.[0],
      "Expected terminal context metadata to be persisted.",
    ).toMatchObject({
      id: "ctx-persist",
      terminalId: "default",
      terminalLabel: "Terminal 1",
      lineStart: 4,
      lineEnd: 5,
    });
    expect(
      persistedState.draftsByThreadKey?.[threadKeyFor(threadId, TEST_ENVIRONMENT_ID)]
        ?.terminalContexts?.[0]?.text,
    ).toBeUndefined();
  });

  it("hydrates persisted terminal contexts without in-memory snapshot text", () => {
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };

    const mergedState = persistApi.getOptions().merge(
      {
        draftsByThreadId: {
          [threadId]: {
            prompt: INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
            attachments: [],
            terminalContexts: [
              {
                id: "ctx-rehydrated",
                threadId,
                createdAt: "2026-03-13T12:00:00.000Z",
                terminalId: "default",
                terminalLabel: "Terminal 1",
                lineStart: 4,
                lineEnd: 5,
              },
            ],
          },
        },
        draftThreadsByThreadId: {},
        projectDraftThreadIdByProjectKey: {},
      },
      useComposerDraftStore.getInitialState(),
    );

    expect(mergedState.draftsByThreadKey[threadKeyFor(threadId)]?.terminalContexts).toMatchObject([
      {
        id: "ctx-rehydrated",
        terminalId: "default",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 5,
        text: "",
      },
    ]);
  });

  it("sanitizes malformed persisted drafts during merge", () => {
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };

    const mergedState = persistApi.getOptions().merge(
      {
        draftsByThreadId: {
          [threadId]: {
            prompt: "",
            attachments: "not-an-array",
            terminalContexts: "not-an-array",
            provider: "bogus-provider",
            modelOptions: "not-an-object",
          },
        },
        draftThreadsByThreadId: "not-an-object",
        projectDraftThreadIdByProjectKey: "not-an-object",
      },
      useComposerDraftStore.getInitialState(),
    );

    expect(mergedState.draftsByThreadKey[threadKeyFor(threadId)]).toBeUndefined();
    expect(mergedState.draftThreadsByThreadKey).toEqual({});
    expect(mergedState.logicalProjectDraftThreadKeyByLogicalProjectKey).toEqual({});
  });
});

describe("composerDraftStore element contexts", () => {
  const threadId = ThreadId.make("thread-element");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);

  const baseSelection = {
    pageUrl: "https://example.com/dashboard",
    pageTitle: "Dashboard",
    tagName: "button",
    selector: "button.submit",
    htmlPreview: "<button>Save</button>",
    componentName: "SubmitButton",
    source: {
      functionName: "SubmitButton",
      fileName: "/repo/Button.tsx",
      lineNumber: 12,
      columnNumber: 5,
    },
    styles: ".submit { color: white; }",
  } as const;

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("adds an element context and stamps id + threadId + pickedAt", () => {
    const accepted = useComposerDraftStore.getState().addElementContext(threadRef, baseSelection);
    expect(accepted).toBe(true);
    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft?.elementContexts).toHaveLength(1);
    const entry = draft?.elementContexts[0]!;
    expect(entry.id.startsWith("el_")).toBe(true);
    expect(entry.threadId).toBe(threadId);
    expect(entry.pickedAt.length).toBeGreaterThan(0);
    expect(entry.componentName).toBe("SubmitButton");
  });

  it("dedupes by selector + tag + componentName + pageUrl signature", () => {
    const store = useComposerDraftStore.getState();
    expect(store.addElementContext(threadRef, baseSelection)).toBe(true);

    const second = store.addElementContext(threadRef, {
      ...baseSelection,
      htmlPreview: "<button>Save 2</button>",
    });

    expect(second).toBe(false);
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.elementContexts).toHaveLength(1);
  });

  it("removeElementContext drops by id + leaves siblings intact", () => {
    const store = useComposerDraftStore.getState();
    store.addElementContext(threadRef, baseSelection);
    store.addElementContext(threadRef, { ...baseSelection, selector: "button.cancel" });
    const ids = draftFor(threadId, TEST_ENVIRONMENT_ID)!.elementContexts.map((c) => c.id);
    store.removeElementContext(threadRef, ids[0]!);
    const remaining = draftFor(threadId, TEST_ENVIRONMENT_ID)?.elementContexts;
    expect(remaining?.map((c) => c.id)).toEqual([ids[1]]);
  });

  it("setElementContexts replaces the slice and clearComposerContent wipes it", () => {
    const store = useComposerDraftStore.getState();
    store.addElementContext(threadRef, baseSelection);
    store.setElementContexts(threadRef, []);
    // Fully empty draft should be removed via shouldRemoveDraft.
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toBeUndefined();

    store.addElementContext(threadRef, baseSelection);
    store.clearComposerContent(threadRef);
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toBeUndefined();
  });

  it("persists element contexts via the partializer (round-trippable)", () => {
    useComposerDraftStore.getState().addElementContext(threadRef, baseSelection);

    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown;
      };
    };

    const persisted = persistApi.getOptions().partialize(useComposerDraftStore.getState()) as {
      draftsByThreadKey?: Record<string, { elementContexts?: Array<Record<string, unknown>> }>;
    };

    const entry =
      persisted.draftsByThreadKey?.[threadKeyFor(threadId, TEST_ENVIRONMENT_ID)]
        ?.elementContexts?.[0];

    expect(entry).toMatchObject({
      pageUrl: baseSelection.pageUrl,
      tagName: baseSelection.tagName,
      selector: baseSelection.selector,
      componentName: baseSelection.componentName,
    });
    // Persistence does NOT include htmlPreview / styles oversize-clamping —
    // that happens at normalization time, before the value reaches the store.
    expect(typeof entry?.htmlPreview).toBe("string");
  });
});

describe("composerDraftStore retired review comments", () => {
  const threadId = ThreadId.make("thread-review-comment");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("hydrates drafts saved with review comments and drops them", () => {
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };

    const mergedState = persistApi.getOptions().merge(
      {
        draftsByThreadId: {
          [threadId]: {
            prompt: "Keep this prompt",
            attachments: [],
            reviewComments: [
              {
                id: "comment-1",
                sectionId: "file:src/app.ts",
                sectionTitle: "File comment",
                filePath: "src/app.ts",
                startIndex: 1,
                endIndex: 2,
                rangeLabel: "L2 to L3",
                text: "Keep this configurable.",
                diff: "@@ -2,2 +2,2 @@\n two\n three",
              },
            ],
          },
        },
        draftThreadsByThreadId: {},
        projectDraftThreadIdByProjectKey: {},
      },
      useComposerDraftStore.getInitialState(),
    );

    const draft = mergedState.draftsByThreadKey[threadKeyFor(threadId)];
    expect(draft?.prompt).toBe("Keep this prompt");
    expect(draft).not.toHaveProperty("reviewComments");
  });
});
