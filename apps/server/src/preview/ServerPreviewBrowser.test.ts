import { it } from "@effect/vitest";
import { ThreadId, type PreviewAutomationRequest } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { expect, vi } from "vite-plus/test";

import * as ServerSettings from "../serverSettings.ts";
import * as PreviewManager from "./Manager.ts";
import * as ServerPreviewBrowser from "./ServerPreviewBrowser.ts";

const playwright = vi.hoisted(() => {
  interface FakePage {
    readonly close: () => Promise<void>;
  }

  interface FakeContext {
    readonly pages: FakePage[];
    readonly close: ReturnType<typeof vi.fn>;
  }

  const browsers: Array<{
    readonly close: ReturnType<typeof vi.fn>;
    readonly newContext: ReturnType<typeof vi.fn>;
  }> = [];

  const contexts: FakeContext[] = [];

  const fakePage = () => {
    const onClose: Array<() => void> = [];

    return {
      url: () => "about:blank",
      title: async () => "",
      viewportSize: () => ({ width: 1280, height: 800 }),
      screenshot: async () => Buffer.from("png"),
      once: (event: string, listener: () => void) => {
        if (event === "close") onClose.push(listener);
      },
      close: vi.fn(async () => {
        for (const listener of onClose.splice(0)) listener();
      }),
    };
  };

  const fakeContext = (): FakeContext & { readonly newPage: () => Promise<FakePage> } => {
    const context = {
      pages: [] as FakePage[],
      close: vi.fn(async () => undefined),
      newPage: async () => {
        const page = fakePage();
        context.pages.push(page);

        return page;
      },
    };

    contexts.push(context);

    return context;
  };

  const connectOverCDP = vi.fn(async () => {
    const browser = {
      contexts: () => [fakeContext()],
      newContext: vi.fn(async () => fakeContext()),
      close: vi.fn(async () => undefined),
    };

    browsers.push(browser);

    return browser;
  });

  return { browsers, contexts, connectOverCDP };
});

vi.mock("playwright-core", () => ({ chromium: { connectOverCDP: playwright.connectOverCDP } }));

let sessions = 0;

const browserbase = HttpClient.make((request) =>
  Effect.sync(() => {
    sessions += 1;

    return HttpClientResponse.fromWeb(
      request,
      Response.json({ id: `session-${sessions}`, connectUrl: `wss://browserbase/${sessions}` }),
    );
  }),
);

const testLayer = ServerPreviewBrowser.layer.pipe(
  Layer.provide(PreviewManager.layer),
  Layer.provide(
    ServerSettings.layerTest({
      browserProvider: { enabled: true, browserbaseApiKey: "test-key" },
    }),
  ),
  Layer.provide(Layer.succeed(HttpClient.HttpClient, browserbase)),
);

const openRequest = (threadId: string, requestId: string): PreviewAutomationRequest => ({
  requestId,
  threadId: ThreadId.make(threadId),
  operation: "open",
  input: { reuseExistingTab: false },
  timeoutMs: 1_000,
});

it.layer(testLayer)("ServerPreviewBrowser", (it) => {
  it.effect("reuses one session across tabs and really closes it on close", () =>
    Effect.gen(function* () {
      const browser = yield* ServerPreviewBrowser.ServerPreviewBrowser;
      yield* Effect.promise(() => browser.handle(openRequest("thread-a", "open-1")));
      yield* Effect.promise(() => browser.handle(openRequest("thread-b", "open-2")));
      expect(sessions).toBe(1);
      expect(playwright.browsers).toHaveLength(1);

      yield* Effect.promise(() => browser.close());
      expect(playwright.browsers[0]!.close).toHaveBeenCalledOnce();

      yield* Effect.promise(() => browser.handle(openRequest("thread-a", "open-3")));
      expect(sessions).toBe(2);
      expect(playwright.browsers).toHaveLength(2);
      expect(playwright.browsers[1]!.close).not.toHaveBeenCalled();

      yield* Effect.promise(() => browser.close());
      expect(playwright.browsers[1]!.close).toHaveBeenCalledOnce();
      expect(playwright.browsers[0]!.close).toHaveBeenCalledOnce();
    }),
  );

  it.effect("gives each thread its own context and closes it with the thread's last tab", () =>
    Effect.gen(function* () {
      const browser = yield* ServerPreviewBrowser.ServerPreviewBrowser;
      yield* Effect.promise(() => browser.handle(openRequest("iso-a", "iso-open-1")));
      yield* Effect.promise(() => browser.handle(openRequest("iso-a", "iso-open-2")));
      yield* Effect.promise(() => browser.handle(openRequest("iso-b", "iso-open-3")));

      const shared = playwright.browsers.at(-1)!;
      expect(shared.newContext).toHaveBeenCalledTimes(2);
      const [contextA, contextB] = playwright.contexts.slice(-2);
      expect(contextA).not.toBe(contextB);
      expect(contextA!.pages).toHaveLength(2);
      expect(contextB!.pages).toHaveLength(1);

      yield* Effect.promise(() => contextA!.pages[0]!.close());
      expect(contextA!.close).not.toHaveBeenCalled();

      yield* Effect.promise(() => contextA!.pages[1]!.close());
      yield* Effect.promise(() => vi.waitFor(() => expect(contextA!.close).toHaveBeenCalledOnce()));
      expect(contextB!.close).not.toHaveBeenCalled();

      yield* Effect.promise(() => browser.handle(openRequest("iso-a", "iso-open-4")));
      expect(shared.newContext).toHaveBeenCalledTimes(3);
      expect(playwright.contexts.at(-1)).not.toBe(contextA);

      yield* Effect.promise(() => browser.close());
    }),
  );

  it.effect("does not keep a tab or session from an open that raced close", () =>
    Effect.gen(function* () {
      const browser = yield* ServerPreviewBrowser.ServerPreviewBrowser;
      const opening = browser.handle(openRequest("thread-race", "open-race"));
      yield* Effect.promise(() => browser.close());
      yield* Effect.promise(() => expect(opening).rejects.toThrow("browser was closed"));

      // No Browserbase session outlives the close.
      for (const opened of playwright.browsers) expect(opened.close).toHaveBeenCalledOnce();
    }),
  );
});
