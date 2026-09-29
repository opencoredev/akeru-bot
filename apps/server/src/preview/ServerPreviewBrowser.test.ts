import { it } from "@effect/vitest";
import { ThreadId, type PreviewAutomationRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { expect, vi } from "vite-plus/test";

import * as ServerSettings from "../serverSettings.ts";
import * as PreviewManager from "./Manager.ts";
import * as ServerPreviewBrowser from "./ServerPreviewBrowser.ts";

const playwright = vi.hoisted(() => {
  const browsers: Array<{ readonly close: ReturnType<typeof vi.fn> }> = [];
  const fakePage = () => ({
    url: () => "about:blank",
    title: async () => "",
    viewportSize: () => ({ width: 1280, height: 800 }),
    screenshot: async () => Buffer.from("png"),
    close: vi.fn(async () => undefined),
  });
  const connectOverCDP = vi.fn(async () => {
    const browser = {
      contexts: () => [{ newPage: async () => fakePage() }],
      close: vi.fn(async () => undefined),
    };
    browsers.push(browser);
    return browser;
  });
  return { browsers, connectOverCDP };
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
