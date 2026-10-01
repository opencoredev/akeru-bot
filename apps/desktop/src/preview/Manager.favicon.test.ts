import { it as effectIt } from "@effect/vitest";

import * as Effect from "effect/Effect";

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
  createFromPath: vi.fn((): { readonly isEmpty: () => boolean } => ({ isEmpty: () => false })),
  fromId: vi.fn((_id?: number) => null),
  getFocusedWebContents: vi.fn(() => null),
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

const { withManager, TEST_FAVICON, makeSourcePng, makeFaviconWebContents, settle } =
  createPreviewManagerHarness({
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

  effectIt.effect("publishes a canonical favicon origin while the page is loading", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const preview = makeFaviconWebContents({
          url: `http://localhost:3200/${"x".repeat(3_000)}`,
        });

        preview.setLoading(true);
        fromId.mockReturnValue(preview.webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_loading");
        yield* manager.registerWebview("tab_favicon_loading", 42);

        preview.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* settle(() => states.at(-1)?.favicon !== undefined);

        expect(states.at(-1)?.favicon).toMatchObject({
          dataUrl: TEST_FAVICON,
          pageUrl: "http://localhost:3200",
        });
        expect(states.at(-1)?.favicon?.capturedAt).toEqual(expect.any(Number));
      }),
    ),
  );

  effectIt.effect("shares an identical in-flight event and lets a changed event win", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let resolveFirst!: (response: Response) => void;

        const firstResponse = new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });

        const preview = makeFaviconWebContents({
          fetch: (url) =>
            url.endsWith("first.png")
              ? firstResponse
              : Promise.resolve(
                  new Response(new Uint8Array(makeSourcePng()), {
                    headers: { "content-type": "image/png" },
                  }),
                ),
        });

        fromId.mockReturnValue(preview.webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_latest");
        yield* manager.registerWebview("tab_favicon_latest", 42);

        const faviconUpdated = preview.listeners.get("page-favicon-updated")!;
        faviconUpdated({} as never, ["http://localhost:3200/first.png"] as never);
        faviconUpdated({} as never, ["http://localhost:3200/first.png"] as never);
        yield* settle(() => preview.fetch.mock.calls.length === 1);
        faviconUpdated({} as never, ["http://localhost:3200/second.png"] as never);
        yield* settle(() => states.at(-1)?.favicon !== undefined);
        resolveFirst(
          new Response(new Uint8Array(makeSourcePng()), {
            headers: { "content-type": "image/png" },
          }),
        );
        yield* settle(() => false);

        expect(preview.fetch).toHaveBeenCalledTimes(2);
        expect(states.filter((state) => state.favicon !== undefined)).toHaveLength(1);
      }),
    ),
  );

  effectIt.effect("allows an identical retry after an undecodable capture", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let rasterizations = 0;

        const preview = makeFaviconWebContents({
          rasterize: async () => (++rasterizations === 1 ? null : TEST_FAVICON),
        });

        fromId.mockReturnValue(preview.webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_retry");
        yield* manager.registerWebview("tab_favicon_retry", 42);
        const faviconUpdated = preview.listeners.get("page-favicon-updated")!;

        faviconUpdated({} as never, ["http://localhost:3200/favicon.png"] as never);
        yield* settle(() => rasterizations === 1);
        yield* settle(() => false);
        faviconUpdated({} as never, ["http://localhost:3200/favicon.png"] as never);
        yield* settle(() => states.at(-1)?.favicon !== undefined);

        expect(rasterizations).toBe(2);
        expect(states.at(-1)?.favicon?.dataUrl).toBe(TEST_FAVICON);
      }),
    ),
  );

  effectIt.effect("does not publish a capture invalidated by navigation", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let resolveFetch!: (response: Response) => void;

        const preview = makeFaviconWebContents({
          fetch: () =>
            new Promise<Response>((resolve) => {
              resolveFetch = resolve;
            }),
        });

        fromId.mockReturnValue(preview.webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_navigation");
        yield* manager.registerWebview("tab_favicon_navigation", 42);
        preview.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* settle(() => preview.fetch.mock.calls.length === 1);
        preview.listeners.get("did-start-navigation")?.({
          isMainFrame: true,
          isSameDocument: false,
        } as never);
        preview.setUrl("https://example.com/");
        resolveFetch(
          new Response(new Uint8Array(makeSourcePng()), {
            headers: { "content-type": "image/png" },
          }),
        );
        yield* settle(() => false);

        expect(states.some((state) => state.favicon !== undefined)).toBe(false);
      }),
    ),
  );

  effectIt.effect("retains a favicon when reloading the current URL without a new event", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const preview = makeFaviconWebContents();
        fromId.mockReturnValue(preview.webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_reload");
        yield* manager.registerWebview("tab_favicon_reload", 42);
        preview.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* settle(() => states.at(-1)?.favicon !== undefined);

        yield* manager.navigate("tab_favicon_reload", "http://localhost:3200/");

        expect(preview.reload).toHaveBeenCalledOnce();
        expect(states.at(-1)?.favicon?.dataUrl).toBe(TEST_FAVICON);
      }),
    ),
  );

  effectIt.effect("clears a published favicon after a confirmed cross-origin navigation", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const preview = makeFaviconWebContents();
        fromId.mockReturnValue(preview.webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_origin");
        yield* manager.registerWebview("tab_favicon_origin", 42);
        preview.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* settle(() => states.at(-1)?.favicon !== undefined);

        preview.setUrl("https://example.com/");
        preview.listeners.get("did-navigate")?.({} as never);
        yield* settle(() => states.at(-1)?.navStatus.kind === "Success");

        expect(states.at(-1)?.favicon).toBeUndefined();
      }),
    ),
  );

  effectIt.effect(
    "retains the previous document icon across a failed cross-origin navigation",
    () =>
      withManager((manager) =>
        Effect.gen(function* () {
          const preview = makeFaviconWebContents();
          fromId.mockReturnValue(preview.webContents);
          const states: PreviewManager.PreviewTabState[] = [];
          yield* manager.subscribeStateChanges((_tabId, state) =>
            Effect.sync(() => {
              states.push(state);
            }),
          );
          yield* manager.createTab("tab_favicon_failed_origin");
          yield* manager.registerWebview("tab_favicon_failed_origin", 42);
          preview.listeners.get("page-favicon-updated")?.(
            {} as never,
            ["http://localhost:3200/favicon.png"] as never,
          );
          yield* settle(() => states.at(-1)?.favicon !== undefined);

          preview.listeners.get("did-fail-load")?.(
            {} as never,
            -105 as never,
            "Name not resolved" as never,
            "https://unreachable.example/" as never,
            true as never,
          );
          yield* settle(() => states.at(-1)?.navStatus.kind === "LoadFailed");
          expect(states.at(-1)?.favicon?.dataUrl).toBe(TEST_FAVICON);

          preview.listeners.get("did-navigate")?.({} as never);
          yield* settle(() => states.at(-1)?.navStatus.kind === "Success");
          expect(states.at(-1)?.favicon?.dataUrl).toBe(TEST_FAVICON);
        }),
      ),
  );

  effectIt.effect("does not resurrect an icon after a confirmed about:blank document", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const preview = makeFaviconWebContents();
        fromId.mockReturnValue(preview.webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_blank");
        yield* manager.registerWebview("tab_favicon_blank", 42);
        preview.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* settle(() => states.at(-1)?.favicon !== undefined);

        preview.setUrl("about:blank");
        preview.listeners.get("did-navigate")?.({} as never);
        yield* settle(() => states.at(-1)?.navStatus.kind === "Idle");
        expect(states.at(-1)?.favicon).toBeUndefined();

        preview.setUrl("http://localhost:3200/");
        preview.listeners.get("did-navigate")?.({} as never);
        yield* settle(() => states.at(-1)?.navStatus.kind === "Success");
        expect(states.at(-1)?.favicon).toBeUndefined();
      }),
    ),
  );

  effectIt.effect("clears a published favicon when a replacement webview attaches", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const initial = makeFaviconWebContents({ id: 42 });
        const replacement = makeFaviconWebContents({ id: 43 });
        fromId.mockImplementation((id?: number) => {
          if (id === 42) return initial.webContents;

          if (id === 43) return replacement.webContents;

          return null;
        });
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_replace");
        yield* manager.registerWebview("tab_favicon_replace", 42);
        initial.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* settle(() => states.at(-1)?.favicon !== undefined);

        yield* manager.registerWebview("tab_favicon_replace", 43);

        expect(states.at(-1)?.webContentsId).toBe(43);
        expect(states.at(-1)?.favicon).toBeUndefined();
      }),
    ),
  );

  effectIt.effect("ignores an old capture that completes after webview replacement", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let resolveFetch!: (response: Response) => void;

        const initial = makeFaviconWebContents({
          id: 42,
          fetch: () =>
            new Promise<Response>((resolve) => {
              resolveFetch = resolve;
            }),
        });

        const replacement = makeFaviconWebContents({ id: 43 });
        fromId.mockImplementation((id?: number) =>
          id === 42 ? initial.webContents : id === 43 ? replacement.webContents : null,
        );
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_late_replace");
        yield* manager.registerWebview("tab_favicon_late_replace", 42);
        initial.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* settle(() => initial.fetch.mock.calls.length === 1);

        yield* manager.registerWebview("tab_favicon_late_replace", 43);
        resolveFetch(
          new Response(new Uint8Array(makeSourcePng()), {
            headers: { "content-type": "image/png" },
          }),
        );
        yield* settle(() => false);

        expect(states.at(-1)?.webContentsId).toBe(43);
        expect(
          states.some((state) => state.webContentsId === 43 && state.favicon !== undefined),
        ).toBe(false);
      }),
    ),
  );

  effectIt.effect("treats a reused WebContents id as a new attachment", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const initial = makeFaviconWebContents({ id: 42 });
        const replacement = makeFaviconWebContents({ id: 42 });
        let active = initial.webContents;
        fromId.mockImplementation(() => active);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_reused_id");
        yield* manager.registerWebview("tab_favicon_reused_id", 42);
        initial.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* settle(() => states.at(-1)?.favicon !== undefined);

        active = replacement.webContents;
        yield* manager.registerWebview("tab_favicon_reused_id", 42);

        expect(states.at(-1)?.favicon).toBeUndefined();
        expect(initial.off).toHaveBeenCalled();
        expect(replacement.listeners.has("page-favicon-updated")).toBe(true);
      }),
    ),
  );

  effectIt.effect("preserves a favicon when the active attachment registers again", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const preview = makeFaviconWebContents();
        fromId.mockReturnValue(preview.webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_favicon_reregister");
        yield* manager.registerWebview("tab_favicon_reregister", 42);
        preview.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* settle(() => states.at(-1)?.favicon !== undefined);

        yield* manager.registerWebview("tab_favicon_reregister", 42);

        expect(states.at(-1)?.favicon?.dataUrl).toBe(TEST_FAVICON);
      }),
    ),
  );
});
