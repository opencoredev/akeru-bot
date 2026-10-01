import { scopeThreadRef } from "@akeru/client-runtime/environment";
import * as Schema from "effect/Schema";
import { ThreadId } from "@akeru/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { COMPOSER_DRAFT_STORAGE_KEY, useComposerDraftStore, DraftId } from "./composerDraftStore";
import { removeLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "./lib/terminalContext";
import {
  TEST_ENVIRONMENT_ID,
  resetComposerDraftStore,
  makeImage,
  draftFor,
  draftByKey,
  makeTerminalContext,
} from "./composerDraftStore.test-support";

describe("composerDraftStore addImages", () => {
  const threadId = ThreadId.make("thread-dedupe");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL;
  let revokeSpy: ReturnType<typeof vi.fn<(url: string) => void>>;

  beforeEach(() => {
    resetComposerDraftStore();
    originalRevokeObjectUrl = URL.revokeObjectURL;
    revokeSpy = vi.fn();
    URL.revokeObjectURL = revokeSpy;
  });

  afterEach(() => {
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  it("deduplicates identical images in one batch by file signature", () => {
    const first = makeImage({
      id: "img-1",
      previewUrl: "blob:first",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 12,
      lastModified: 12345,
    });
    const duplicate = makeImage({
      id: "img-2",
      previewUrl: "blob:duplicate",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 12,
      lastModified: 12345,
    });

    useComposerDraftStore.getState().addImages(threadRef, [first, duplicate]);

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft?.images.map((image) => image.id)).toEqual(["img-1"]);
    expect(revokeSpy).toHaveBeenCalledWith("blob:duplicate");
  });

  it("deduplicates against existing images across calls by file signature", () => {
    const first = makeImage({
      id: "img-a",
      previewUrl: "blob:a",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 9,
      lastModified: 777,
    });
    const duplicateLater = makeImage({
      id: "img-b",
      previewUrl: "blob:b",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 9,
      lastModified: 999,
    });

    useComposerDraftStore.getState().addImage(threadRef, first);
    useComposerDraftStore.getState().addImage(threadRef, duplicateLater);

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft?.images.map((image) => image.id)).toEqual(["img-a"]);
    expect(revokeSpy).toHaveBeenCalledWith("blob:b");
  });

  it("does not revoke blob URLs that are still used by an accepted duplicate image", () => {
    const first = makeImage({
      id: "img-shared",
      previewUrl: "blob:shared",
    });
    const duplicateSameUrl = makeImage({
      id: "img-shared",
      previewUrl: "blob:shared",
    });

    useComposerDraftStore.getState().addImages(threadRef, [first, duplicateSameUrl]);

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft?.images.map((image) => image.id)).toEqual(["img-shared"]);
    expect(revokeSpy).not.toHaveBeenCalledWith("blob:shared");
  });
});

describe("composerDraftStore clearComposerContent", () => {
  const threadId = ThreadId.make("thread-clear");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL;
  let revokeSpy: ReturnType<typeof vi.fn<(url: string) => void>>;

  beforeEach(() => {
    resetComposerDraftStore();
    originalRevokeObjectUrl = URL.revokeObjectURL;
    revokeSpy = vi.fn();
    URL.revokeObjectURL = revokeSpy;
  });

  afterEach(() => {
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  it("does not revoke blob preview URLs when clearing composer content", () => {
    const first = makeImage({
      id: "img-optimistic",
      previewUrl: "blob:optimistic",
    });
    useComposerDraftStore.getState().addImage(threadRef, first);

    useComposerDraftStore.getState().clearComposerContent(threadRef);

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft).toBeUndefined();
    expect(revokeSpy).not.toHaveBeenCalledWith("blob:optimistic");
  });
});

describe("composerDraftStore moveComposerPromptAndImages", () => {
  const sourceDraftId = DraftId.make("draft-move-source");
  const destinationDraftId = DraftId.make("draft-move-destination");
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL;
  let revokeSpy: ReturnType<typeof vi.fn<(url: string) => void>>;

  beforeEach(() => {
    resetComposerDraftStore();
    originalRevokeObjectUrl = URL.revokeObjectURL;
    revokeSpy = vi.fn();
    URL.revokeObjectURL = revokeSpy;
  });

  afterEach(() => {
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  it("moves prompt and images to the destination without revoking preview URLs", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(sourceDraftId, "fix the login redirect");
    store.addImages(sourceDraftId, [makeImage({ id: "img-move", previewUrl: "blob:move" })]);

    store.moveComposerPromptAndImages(sourceDraftId, destinationDraftId);

    expect(draftByKey(sourceDraftId)).toBeUndefined();
    const destination = draftByKey(destinationDraftId);
    expect(destination?.prompt).toBe("fix the login redirect");
    expect(destination?.images.map((image) => image.id)).toEqual(["img-move"]);
    expect(revokeSpy).not.toHaveBeenCalled();
  });

  it("keeps session-bound contexts on the source and strips their placeholders from the moved prompt", () => {
    const sourceThreadId = ThreadId.make("thread-move-source");
    const sourceThreadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, sourceThreadId);
    const store = useComposerDraftStore.getState();
    store.addTerminalContext(sourceThreadRef, makeTerminalContext({ id: "ctx-stay" }));
    store.setPrompt(sourceThreadRef, `${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} explain this error`);

    store.moveComposerPromptAndImages(sourceThreadRef, destinationDraftId);

    const source = draftFor(sourceThreadId, TEST_ENVIRONMENT_ID);
    expect(source?.terminalContexts.map((context) => context.id)).toEqual(["ctx-stay"]);
    expect(source?.prompt).toBe(INLINE_TERMINAL_CONTEXT_PLACEHOLDER);
    expect(draftByKey(destinationDraftId)?.prompt).toBe(" explain this error");
  });

  it("is a no-op when source and destination are the same target", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(sourceDraftId, "keep me");

    store.moveComposerPromptAndImages(sourceDraftId, sourceDraftId);

    expect(draftByKey(sourceDraftId)?.prompt).toBe("keep me");
  });
});

describe("composerDraftStore syncPersistedAttachments", () => {
  const threadId = ThreadId.make("thread-sync-persisted");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);

  beforeEach(() => {
    removeLocalStorageItem(COMPOSER_DRAFT_STORAGE_KEY);
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
  });

  afterEach(() => {
    removeLocalStorageItem(COMPOSER_DRAFT_STORAGE_KEY);
  });

  it("treats malformed persisted draft storage as empty", async () => {
    const image = makeImage({
      id: "img-persisted",
      previewUrl: "blob:persisted",
    });
    useComposerDraftStore.getState().addImage(threadRef, image);
    setLocalStorageItem(
      COMPOSER_DRAFT_STORAGE_KEY,
      {
        version: 2,
        state: {
          draftsByThreadId: {
            [threadId]: {
              attachments: "not-an-array",
            },
          },
        },
      },
      Schema.Unknown,
    );

    useComposerDraftStore.getState().syncPersistedAttachments(threadRef, [
      {
        id: image.id,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: image.previewUrl,
      },
    ]);
    await Promise.resolve();

    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.persistedAttachments).toEqual([]);
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.nonPersistedImageIds).toEqual([image.id]);
  });
});
