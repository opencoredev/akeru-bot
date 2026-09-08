import {
  FILL_PREVIEW_VIEWPORT,
  type PreviewAutomationClickInput,
  type PreviewAutomationEvaluateInput,
  type PreviewAutomationNavigateInput,
  type PreviewAutomationOpenInput,
  type PreviewAutomationPressInput,
  type PreviewAutomationRequest,
  type PreviewAutomationResizeInput,
  type PreviewAutomationScrollInput,
  type PreviewAutomationSetColorSchemeInput,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
  type PreviewAutomationTypeInput,
  type PreviewAutomationWaitForInput,
  type PreviewRenderedViewportSize,
  type PreviewTabId,
  type ThreadId,
} from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { resolvePreviewViewport } from "@t3tools/shared/previewViewport";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

import * as ServerSettings from "../serverSettings.ts";
import * as PreviewManager from "./Manager.ts";

const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;

interface BrowserTab {
  readonly threadId: ThreadId;
  readonly page: Page;
  loading: boolean;
}

interface BrowserbaseSession {
  readonly id: string;
  readonly connectUrl: string;
}

const requestedUrl = (input: PreviewAutomationNavigateInput): string => {
  if (input.url) return normalizePreviewUrl(input.url);
  const target = input.target!;
  if (target.kind === "url") return normalizePreviewUrl(target.url);
  const path = target.path?.startsWith("/") ? target.path : `/${target.path ?? ""}`;
  return `${target.protocol ?? "http"}://127.0.0.1:${target.port}${path}`;
};

const viewportForSetting = (
  setting: ReturnType<typeof resolvePreviewViewport> | typeof FILL_PREVIEW_VIEWPORT,
): PreviewRenderedViewportSize =>
  setting._tag === "fill" ? DEFAULT_VIEWPORT : { width: setting.width, height: setting.height };

const selectorFor = (input: {
  readonly locator?: string | undefined;
  readonly selector?: string | undefined;
}) => input.locator ?? input.selector ?? null;

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "Browser operation failed.";

export class ServerPreviewBrowser extends Context.Service<
  ServerPreviewBrowser,
  {
    readonly handle: (request: PreviewAutomationRequest) => Promise<unknown>;
    readonly close: () => Promise<void>;
  }
>()("akeru-bot/preview/ServerPreviewBrowser") {}

export const make = Effect.gen(function* ServerPreviewBrowserMake() {
  const previewManager = yield* PreviewManager.PreviewManager;
  const httpClient = yield* HttpClient.HttpClient;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const tabs = new Map<PreviewTabId, BrowserTab>();
  const activeByThread = new Map<string, PreviewTabId>();
  let contextPromise: Promise<BrowserContext> | null = null;
  let browserPromise: Promise<Browser> | null = null;

  const requireApiKey = async () => {
    const settings = await Effect.runPromise(settingsService.getSettings);
    if (!settings.browserProvider.enabled) {
      throw new Error("Browserbase is disabled. Enable it in Settings > Browser.");
    }
    const apiKey = settings.browserProvider.browserbaseApiKey || process.env.BROWSERBASE_API_KEY;
    if (!apiKey) throw new Error("Browserbase is not configured.");
    return apiKey;
  };

  const getContext = () => {
    contextPromise ??= (async () => {
      const apiKey = await requireApiKey();
      const session = await Effect.runPromise(
        httpClient
          .post("https://api.browserbase.com/v1/sessions", {
            headers: {
              "Content-Type": "application/json",
              "X-BB-API-Key": apiKey,
            },
            body: HttpBody.jsonUnsafe({
              browserSettings: { viewport: DEFAULT_VIEWPORT, recordSession: true },
            }),
          })
          .pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap((response) => response.json),
            Effect.map((value) => value as unknown as BrowserbaseSession),
          ),
      );
      browserPromise = chromium.connectOverCDP(session.connectUrl);
      const browser = await browserPromise;
      const context = browser.contexts()[0];
      if (!context) throw new Error("Browserbase returned no browser context.");
      return context;
    })().catch((cause) => {
      contextPromise = null;
      throw cause;
    });
    return contextPromise;
  };

  const resolveTab = (request: PreviewAutomationRequest): BrowserTab => {
    const tabId = request.tabId ?? activeByThread.get(request.threadId);
    const tab = tabId ? tabs.get(tabId) : undefined;
    if (!tab || tab.threadId !== request.threadId) {
      throw new Error("No active browser tab exists for this chat.");
    }
    return tab;
  };

  const tabIdFor = (tab: BrowserTab): PreviewTabId => {
    for (const [tabId, candidate] of tabs) if (candidate === tab) return tabId;
    throw new Error("Browser tab is no longer active.");
  };

  const status = async (tab: BrowserTab | null): Promise<PreviewAutomationStatus> => {
    if (!tab) {
      return {
        available: true,
        visible: false,
        tabId: null,
        url: null,
        title: null,
        loading: false,
      };
    }
    return {
      available: true,
      visible: true,
      tabId: tabIdFor(tab),
      url: tab.page.url() === "about:blank" ? null : tab.page.url(),
      title: await tab.page.title(),
      loading: tab.loading,
      viewportSetting: FILL_PREVIEW_VIEWPORT,
      viewport: tab.page.viewportSize() ?? DEFAULT_VIEWPORT,
    };
  };

  const publishFrame = async (
    tab: BrowserTab,
  ): Promise<PreviewAutomationSnapshot["screenshot"]> => {
    const data = await tab.page.screenshot({ type: "png" });
    const viewport = tab.page.viewportSize() ?? DEFAULT_VIEWPORT;
    const screenshot = {
      mimeType: "image/png" as const,
      data: data.toString("base64"),
      width: viewport.width,
      height: viewport.height,
    };
    await Effect.runPromise(
      previewManager.reportFrame({
        threadId: tab.threadId,
        tabId: tabIdFor(tab),
        frame: screenshot,
      }),
    );
    return screenshot;
  };

  const reportPageStatus = async (tab: BrowserTab): Promise<void> => {
    const url = tab.page.url();
    await Effect.runPromise(
      previewManager.reportStatus({
        threadId: tab.threadId,
        tabId: tabIdFor(tab),
        navStatus: {
          _tag: "Success",
          url: url === "about:blank" ? "about:blank" : url,
          title: await tab.page.title(),
        },
        canGoBack: false,
        canGoForward: false,
      }),
    );
  };

  const navigate = async (
    tab: BrowserTab,
    input: PreviewAutomationNavigateInput,
    fallbackTimeout: number,
  ) => {
    const url = requestedUrl(input);
    const readiness = input.readiness ?? "load";
    tab.loading = true;
    try {
      await tab.page.goto(url, {
        timeout: input.timeoutMs ?? fallbackTimeout,
        waitUntil:
          readiness === "domContentLoaded"
            ? "domcontentloaded"
            : readiness === "none"
              ? "commit"
              : "load",
      });
      tab.loading = false;
      await reportPageStatus(tab);
      await publishFrame(tab);
      return await status(tab);
    } catch (cause) {
      tab.loading = false;
      throw new Error(errorMessage(cause));
    }
  };

  const handle = async (request: PreviewAutomationRequest): Promise<unknown> => {
    await requireApiKey();
    if (request.operation === "status") {
      const tabId = request.tabId ?? activeByThread.get(request.threadId);
      return await status(tabId ? (tabs.get(tabId) ?? null) : null);
    }

    if (request.operation === "open") {
      const input = request.input as PreviewAutomationOpenInput;
      let tabId = request.tabId ?? activeByThread.get(request.threadId);
      let tab = tabId ? tabs.get(tabId) : undefined;
      if (!tab || input.reuseExistingTab === false) {
        const snapshot = await Effect.runPromise(
          previewManager.open({
            threadId: request.threadId,
            ...(input.url ? { url: input.url } : {}),
          }),
        );
        tabId = snapshot.tabId;
        const page = await (await getContext()).newPage();
        tab = { threadId: request.threadId, page, loading: false };
        tabs.set(tabId, tab);
      }
      activeByThread.set(request.threadId, tabId!);
      if (input.url) {
        return await navigate(tab, { url: input.url }, request.timeoutMs);
      }
      await reportPageStatus(tab);
      await publishFrame(tab);
      return await status(tab);
    }

    const tab = resolveTab(request);
    const tabId = tabIdFor(tab);
    switch (request.operation) {
      case "navigate":
        return await navigate(
          tab,
          request.input as PreviewAutomationNavigateInput,
          request.timeoutMs,
        );
      case "snapshot": {
        const [rawPageData, screenshot] = await Promise.all([
          tab.page.evaluate(`(() => {
            const nodes = Array.from(document.querySelectorAll("a,button,input,textarea,select,[role],[contenteditable='true']")).slice(0, 200);
            return {
              visibleText: document.body?.innerText ?? "",
              interactiveElements: nodes.map((element, index) => {
                const rect = element.getBoundingClientRect();
                return {
                  tag: element.tagName.toLowerCase(),
                  role: element.getAttribute("role"),
                  name: element.getAttribute("aria-label") ?? element.innerText ?? element.getAttribute("placeholder") ?? "",
                  selector: element.id ? "#" + CSS.escape(element.id) : element.tagName.toLowerCase() + ":nth-of-type(" + (index + 1) + ")",
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                };
              }),
            };
          })()`),
          publishFrame(tab),
        ]);
        const pageData = rawPageData as {
          readonly visibleText: string;
          readonly interactiveElements: PreviewAutomationSnapshot["interactiveElements"];
        };
        return {
          url: tab.page.url(),
          title: await tab.page.title(),
          loading: tab.loading,
          ...pageData,
          accessibilityTree: await tab.page
            .locator("body")
            .ariaSnapshot()
            .catch(() => null),
          consoleEntries: [],
          networkEntries: [],
          actionTimeline: [],
          screenshot,
        } satisfies PreviewAutomationSnapshot;
      }
      case "click": {
        const input = request.input as PreviewAutomationClickInput;
        const selector = selectorFor(input);
        if (selector)
          await tab.page.locator(selector).click({ timeout: input.timeoutMs ?? request.timeoutMs });
        else await tab.page.mouse.click(input.x!, input.y!);
        await publishFrame(tab);
        return undefined;
      }
      case "type": {
        const input = request.input as PreviewAutomationTypeInput;
        const selector = selectorFor(input);
        if (selector) {
          const locator = tab.page.locator(selector);
          if (input.clear)
            await locator.fill(input.text, { timeout: input.timeoutMs ?? request.timeoutMs });
          else {
            await locator.focus({ timeout: input.timeoutMs ?? request.timeoutMs });
            await tab.page.keyboard.insertText(input.text);
          }
        } else {
          if (input.clear) await tab.page.keyboard.press("Meta+A");
          await tab.page.keyboard.insertText(input.text);
        }
        await publishFrame(tab);
        return undefined;
      }
      case "press": {
        const input = request.input as PreviewAutomationPressInput;
        await tab.page.keyboard.press([...(input.modifiers ?? []), input.key].join("+"));
        await publishFrame(tab);
        return undefined;
      }
      case "scroll": {
        const input = request.input as PreviewAutomationScrollInput;
        const selector = selectorFor(input);
        if (selector) {
          await tab.page
            .locator(selector)
            .evaluate((element, delta) => element.scrollBy(delta.x, delta.y), {
              x: input.deltaX ?? 0,
              y: input.deltaY ?? 0,
            });
        } else await tab.page.mouse.wheel(input.deltaX ?? 0, input.deltaY ?? 0);
        await publishFrame(tab);
        return undefined;
      }
      case "evaluate": {
        const input = request.input as PreviewAutomationEvaluateInput;
        const session = await (await getContext()).newCDPSession(tab.page);
        try {
          const result = await session.send("Runtime.evaluate", {
            expression: input.expression,
            awaitPromise: input.awaitPromise ?? true,
            returnByValue: input.returnByValue ?? true,
          });
          await publishFrame(tab);
          if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
          return result.result.value ?? result.result.description ?? null;
        } finally {
          await session.detach();
        }
      }
      case "waitFor": {
        const input = request.input as PreviewAutomationWaitForInput;
        const timeout = input.timeoutMs ?? request.timeoutMs;
        const waits: Promise<unknown>[] = [];
        const selector = selectorFor(input);
        if (selector) waits.push(tab.page.locator(selector).waitFor({ state: "visible", timeout }));
        if (input.text)
          waits.push(tab.page.getByText(input.text, { exact: false }).first().waitFor({ timeout }));
        if (input.urlIncludes)
          waits.push(
            tab.page.waitForURL((url) => url.href.includes(input.urlIncludes!), { timeout }),
          );
        await Promise.all(waits);
        await publishFrame(tab);
        return undefined;
      }
      case "resize": {
        const input = request.input as PreviewAutomationResizeInput;
        const setting = resolvePreviewViewport(input);
        const viewport = viewportForSetting(setting);
        await tab.page.setViewportSize(viewport);
        await Effect.runPromise(
          previewManager.resize({ threadId: request.threadId, tabId, viewport: setting }),
        );
        await publishFrame(tab);
        return { tabId, setting, viewport };
      }
      case "setColorScheme": {
        const input = request.input as PreviewAutomationSetColorSchemeInput;
        await tab.page.emulateMedia({
          colorScheme: input.colorScheme === "system" ? null : input.colorScheme,
        });
        await publishFrame(tab);
        return { tabId, colorScheme: input.colorScheme };
      }
      case "recordingStart":
      case "recordingStop":
        throw new Error("Browser recording is not available in the web preview host.");
      default:
        throw new Error(`Unsupported browser operation: ${request.operation satisfies never}`);
    }
  };

  const close = async () => {
    const browser = await browserPromise?.catch(() => null);
    await browser?.close();
  };

  return ServerPreviewBrowser.of({ handle, close });
});

export const layer = Layer.effect(
  ServerPreviewBrowser,
  Effect.acquireRelease(make, (browser) =>
    Effect.promise(() => browser.close()).pipe(Effect.orDie),
  ),
);
