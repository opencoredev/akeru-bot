import { it as effectIt } from "@effect/vitest";

import * as Effect from "effect/Effect";

import * as Exit from "effect/Exit";

import { beforeEach, describe, expect, vi } from "vite-plus/test";

import * as PreviewManager from "./Manager.ts";

import { createPreviewManagerHarness } from "./test-support/PreviewManagerHarness.ts";

const {
  browserWindowConstructor,
  createFromBuffer,
  createFromPath,
  fromId,
  getFocusedWebContents,
  mkdir,
  showItemInFolder,
  webviewSend,
  writeFile,
  writeImage,
} = vi.hoisted(() => ({
  browserWindowConstructor: vi.fn(),
  createFromBuffer: vi.fn(),
  createFromPath: vi.fn((): Pick<Electron.NativeImage, "isEmpty"> => ({ isEmpty: () => false })),
  fromId: vi.fn((_id?: number): Electron.WebContents | null => null),
  getFocusedWebContents: vi.fn((): Electron.WebContents | null => null),
  mkdir: vi.fn((_path: string) => undefined),
  showItemInFolder: vi.fn(),
  webviewSend: vi.fn(),
  writeFile: vi.fn((_path: string, _data: Uint8Array) => undefined),
  writeImage: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: browserWindowConstructor,
  clipboard: {
    writeImage,
  },
  nativeImage: {
    createFromBuffer,
    createFromPath,
  },
  shell: {
    showItemInFolder,
  },
  session: {
    fromPartition: vi.fn(),
  },
  webContents: {
    fromId,
    getFocusedWebContents,
  },
}));

const { withManager } = createPreviewManagerHarness({
  browserWindowConstructor,
  createFromBuffer,
  createFromPath,
  fromId,
  getFocusedWebContents,
  mkdir,
  showItemInFolder,
  webviewSend,
  writeFile,
  writeImage,
});

describe("PreviewManager", () => {
  beforeEach(() => {
    browserWindowConstructor.mockReset();
    fromId.mockClear();
    getFocusedWebContents.mockReset();
    getFocusedWebContents.mockReturnValue(null);
    mkdir.mockClear();
    writeFile.mockClear();
    showItemInFolder.mockClear();
    writeImage.mockClear();
    createFromPath.mockClear();
    createFromBuffer.mockReset();
    webviewSend.mockClear();
  });

  const makeAudioWebContents = (id: number) => {
    const listeners = new Map<string, (...args: never[]) => void>();
    const setAudioMuted = vi.fn();
    let audible = false;
    let audibleAfterFirstRead = false;
    let audibleReads = 0;

    return {
      setAudioMuted,
      emitAudioState: (next: boolean) => {
        audible = next;
        listeners.get("audio-state-changed")?.({ audible: next } as never);
      },
      /**
       * Starts playing between the attach-time read and the post-attach
       * reconcile, without a delivered event — the window in which
       * audio-state-changed fires against a guest the tab does not own yet.
       */
      startPlayingAfterFirstRead: () => {
        audibleAfterFirstRead = true;
      },
      wc: {
        id,
        isDestroyed: () => false,
        isDevToolsOpened: () => false,
        getType: () => "webview",
        getURL: () => "https://example.com",
        getTitle: () => "Example",
        isLoading: () => false,
        getZoomFactor: () => 1,
        setZoomFactor: vi.fn(),
        setAudioMuted,
        isCurrentlyAudible: () => {
          audibleReads += 1;

          if (audibleAfterFirstRead && audibleReads > 1) return true;

          return audible;
        },
        loadURL: vi.fn(async () => undefined),
        on: vi.fn((event: string, listener: (...args: never[]) => void) => {
          listeners.set(event, listener);
        }),
        off: vi.fn((event: string) => {
          listeners.delete(event);
        }),
        ipc: { on: vi.fn(), off: vi.fn() },
        send: webviewSend,
        navigationHistory: { canGoBack: () => false, canGoForward: () => false },
        setIgnoreMenuShortcuts: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        debugger: {
          isAttached: () => false,
          attach: vi.fn(),
          sendCommand: vi.fn(async () => undefined),
          on: vi.fn(),
          off: vi.fn(),
        },
      } as never,
    };
  };

  effectIt.effect("mutes the guest and re-applies the mute across webview swaps", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const first = makeAudioWebContents(42);
        fromId.mockReturnValue(first.wc);
        const states: PreviewManager.PreviewTabState[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_audio");
        yield* manager.registerWebview("tab_audio", 42);
        yield* Effect.yieldNow;

        expect(states.at(-1)?.audioMuted).toBe(false);

        yield* manager.setAudioMuted("tab_audio", true);

        expect(first.setAudioMuted).toHaveBeenCalledWith(true);
        expect(states.at(-1)?.audioMuted).toBe(true);

        const replacement = makeAudioWebContents(43);
        fromId.mockReturnValue(replacement.wc);
        yield* manager.registerWebview("tab_audio", 43);
        yield* Effect.yieldNow;

        expect(replacement.setAudioMuted).toHaveBeenCalledWith(true);
        expect(states.at(-1)?.audioMuted).toBe(true);

        yield* manager.setAudioMuted("tab_audio", false);

        expect(replacement.setAudioMuted).toHaveBeenLastCalledWith(false);
        expect(states.at(-1)?.audioMuted).toBe(false);
      }),
    ),
  );

  effectIt.effect("fails and rolls back when the guest refuses a mute", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const guest = makeAudioWebContents(42);
        fromId.mockReturnValue(guest.wc);
        const states: PreviewManager.PreviewTabState[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_audio_fail");
        yield* manager.registerWebview("tab_audio_fail", 42);
        yield* Effect.yieldNow;

        guest.setAudioMuted.mockImplementationOnce(() => {
          throw new Error("guest refused");
        });
        const exit = yield* manager.setAudioMuted("tab_audio_fail", true).pipe(Effect.exit);

        // Reporting success would draw the tab as muted while it keeps playing.
        expect(Exit.isFailure(exit)).toBe(true);
        expect(states.at(-1)?.audioMuted).toBe(false);
      }),
    ),
  );

  effectIt.effect("still registers a guest that refuses the mute reassert", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const first = makeAudioWebContents(42);
        fromId.mockReturnValue(first.wc);
        yield* manager.createTab("tab_audio_attach_fail");
        yield* manager.registerWebview("tab_audio_attach_fail", 42);
        yield* Effect.yieldNow;
        yield* manager.setAudioMuted("tab_audio_attach_fail", true);

        const replacement = makeAudioWebContents(43);
        // Fails the post-attach settle, not the pre-publish apply.
        replacement.setAudioMuted.mockImplementationOnce(() => undefined);
        replacement.setAudioMuted.mockImplementationOnce(() => {
          throw new Error("guest went away");
        });
        fromId.mockReturnValue(replacement.wc);

        // Reconciliation is best-effort: a guest dying mid-attach must not fail
        // the registration it was attaching for.
        const exit = yield* manager.registerWebview("tab_audio_attach_fail", 43).pipe(Effect.exit);
        expect(Exit.isSuccess(exit)).toBe(true);
      }),
    ),
  );

  effectIt.effect("reconciles audibility that changed while the guest attached", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const guest = makeAudioWebContents(42);
        guest.startPlayingAfterFirstRead();
        fromId.mockReturnValue(guest.wc);
        const states: PreviewManager.PreviewTabState[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_audio_window");
        yield* manager.registerWebview("tab_audio_window", 42);
        yield* Effect.yieldNow;

        // audio-state-changed for this transition was dropped: it fired before
        // the tab owned the guest. Without a post-attach reconcile the icon
        // stays wrong until the next real transition, which may never come.
        expect(states.at(-1)?.audible).toBe(true);
      }),
    ),
  );

  effectIt.effect("publishes audibility transitions and drops repeats", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const guest = makeAudioWebContents(42);
        fromId.mockReturnValue(guest.wc);
        const states: PreviewManager.PreviewTabState[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_audible");
        yield* manager.registerWebview("tab_audible", 42);
        yield* Effect.yieldNow;

        expect(states.at(-1)?.audible).toBe(false);

        guest.emitAudioState(true);
        yield* Effect.yieldNow;
        expect(states.at(-1)?.audible).toBe(true);

        // Chromium re-emits per media element; only real transitions publish.
        const publishedAfterFirst = states.length;
        guest.emitAudioState(true);
        yield* Effect.yieldNow;
        expect(states.length).toBe(publishedAfterFirst);

        guest.emitAudioState(false);
        yield* Effect.yieldNow;
        expect(states.at(-1)?.audible).toBe(false);
        expect(states.length).toBeGreaterThan(publishedAfterFirst);
      }),
    ),
  );

  effectIt.effect("ignores audio state from a replaced guest", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const first = makeAudioWebContents(42);
        fromId.mockReturnValue(first.wc);
        const states: PreviewManager.PreviewTabState[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_audio_stale");
        yield* manager.registerWebview("tab_audio_stale", 42);
        yield* Effect.yieldNow;

        const replacement = makeAudioWebContents(43);
        fromId.mockReturnValue(replacement.wc);
        yield* manager.registerWebview("tab_audio_stale", 43);
        yield* Effect.yieldNow;

        const publishedBefore = states.length;
        first.emitAudioState(true);
        yield* Effect.yieldNow;

        expect(states.length).toBe(publishedBefore);
        expect(states.at(-1)?.audible).toBe(false);
      }),
    ),
  );

  effectIt.effect("carries mute and audibility across navigation", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const guest = makeAudioWebContents(42);
        fromId.mockReturnValue(guest.wc);
        const states: PreviewManager.PreviewTabState[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_audio_nav");
        yield* manager.registerWebview("tab_audio_nav", 42);
        yield* Effect.yieldNow;

        yield* manager.setAudioMuted("tab_audio_nav", true);
        guest.emitAudioState(true);
        yield* Effect.yieldNow;
        expect(states.at(-1)?.audible).toBe(true);

        yield* manager.navigate("tab_audio_nav", "https://example.com/next");
        yield* Effect.yieldNow;

        // navigate runs before loadURL swaps the document, so the old page can
        // still be playing. Dropping audibility here would lose the speaker
        // with no transition left to bring it back.
        expect(states.at(-1)?.audioMuted).toBe(true);
        expect(states.at(-1)?.audible).toBe(true);

        // Chromium reports the real stop once the new document takes over.
        guest.emitAudioState(false);
        yield* Effect.yieldNow;
        expect(states.at(-1)?.audible).toBe(false);
      }),
    ),
  );
});
