import type * as Schema from "effect/Schema";

interface PreviewSelectorDiagnostics {
  readonly selectorKind: PreviewAutomationSelectorKind;
  readonly selectorLength?: number;
}

import * as Predicate from "effect/Predicate";
import type { PreviewAutomationSnapshot } from "@akeru/contracts";

import { type BrowserWindow, desktopCapturer, nativeImage } from "electron";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import type * as Fiber from "effect/Fiber";

import * as Option from "effect/Option";

import * as Ref from "effect/Ref";

import { type PreviewAutomationSelectorKind, PreviewOperationError } from "./PreviewErrors.ts";
import type { createPreviewBrowserControl } from "./PreviewBrowserControl.ts";
import type { createPreviewState } from "./PreviewState.ts";
import {
  MAX_VISIBLE_TEXT_LENGTH,
  MAX_INTERACTIVE_ELEMENTS,
  MAX_SCREENSHOT_WIDTH,
  containsVisiblePngPixel,
  scaleCaptureRect,
  normalizeCaptureRect,
  type BrowserDiagnostics,
  type SendCommand,
} from "./PreviewModel.ts";

export const createPreviewAutomationSnapshot = ({
  evaluateWithDebugger,
  diagnosticsRef,
  actionTimelineRef,
  mainWindowRef,
  encodeJson,
  attemptPromise,
  attempt,
  runFork,
  requireWebContents,
  withControlSession,
}: {
  readonly evaluateWithDebugger: ReturnType<
    typeof createPreviewBrowserControl
  >["evaluateWithDebugger"];
  readonly diagnosticsRef: Ref.Ref<ReadonlyMap<number, BrowserDiagnostics>>;
  readonly actionTimelineRef: Ref.Ref<
    ReadonlyMap<
      string,
      readonly {
        readonly status: "running" | "succeeded" | "failed" | "interrupted";
        readonly id: string;
        readonly action: string;
        readonly startedAt: string;
        readonly completedAt?: string | undefined;
        readonly error?: string | undefined;
      }[]
    >
  >;
  readonly mainWindowRef: Ref.Ref<Option.Option<BrowserWindow>>;
  readonly encodeJson: ReturnType<typeof createPreviewState>["encodeJson"];
  readonly attemptPromise: ReturnType<typeof createPreviewState>["attemptPromise"];
  readonly attempt: ReturnType<typeof createPreviewState>["attempt"];
  readonly runFork: <A, E>(
    effect: Effect.Effect<A, E, never>,
    options?: Effect.RunOptions | undefined,
  ) => Fiber.Fiber<A, E>;
  readonly requireWebContents: ReturnType<typeof createPreviewState>["requireWebContents"];
  readonly withControlSession: ReturnType<typeof createPreviewBrowserControl>["withControlSession"];
}) => {
  const automationLocator = (input: {
    readonly selector?: string | undefined;
    readonly locator?: string | undefined;
  }): string | null => input.locator ?? (input.selector ? `css=${input.selector}` : null);

  const automationSelectorDiagnostics = (input: {
    readonly selector?: string | undefined;
    readonly locator?: string | undefined;
  }): PreviewSelectorDiagnostics => {
    if (input.locator !== undefined) {
      return { selectorKind: "locator", selectorLength: input.locator.length };
    }

    if (input.selector !== undefined) {
      return { selectorKind: "selector", selectorLength: input.selector.length };
    }

    return { selectorKind: "focused-element" };
  };

  const captureAutomationSnapshot = Effect.fn("PreviewManager.captureAutomationSnapshot")(
    function* (
      tabId: string,
      wc: Electron.WebContents,
      send: SendCommand,
      sendCleanup: SendCommand,
    ) {
      yield* Effect.all([send("Runtime.enable"), send("Accessibility.enable")], {
        concurrency: 2,
        discard: true,
      });

      const page = yield* evaluateWithDebugger<{
        url: string;
        title: string;
        loading: boolean;
        visibleText: string;
        interactiveElements: PreviewAutomationSnapshot["interactiveElements"];
      }>(
        tabId,
        send,
        `(() => {
          const selectorFor = (element) => {
            if (element.id) return "#" + CSS.escape(element.id);
            for (const attribute of ["data-testid", "name"]) {
              const value = element.getAttribute(attribute);
              if (value) return element.tagName.toLowerCase() + "[" + attribute + "=" + JSON.stringify(value) + "]";
            }
            const buildParts = (current, parts = []) => {
              if (!current || current.nodeType !== Node.ELEMENT_NODE || parts.length >= 8) {
                return parts;
              }
              const parent = current.parentElement;
              const siblings = parent
                ? Array.from(parent.children).filter((child) => child.tagName === current.tagName)
                : [];
              const base = current.tagName.toLowerCase();
              const part = siblings.length > 1
                ? base + ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")"
                : base;
              return buildParts(parent, [part, ...parts]);
            };
            return buildParts(element).join(" > ");
          };
          const visible = (element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
          };
          const elements = Array.from(document.querySelectorAll(
            "a[href],button,input,textarea,select,[role],[tabindex]"
          )).filter(visible).slice(0, ${MAX_INTERACTIVE_ELEMENTS}).map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              tag: element.tagName.toLowerCase(),
              role: element.getAttribute("role"),
              name: element.getAttribute("aria-label") || element.innerText || element.getAttribute("name") || "",
              selector: selectorFor(element),
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height
            };
          });
          return {
            url: location.href,
            title: document.title,
            loading: document.readyState !== "complete",
            visibleText: (document.body?.innerText || "").slice(0, ${MAX_VISIBLE_TEXT_LENGTH}),
            interactiveElements: elements
          };
        })()`,
        true,
      );

      const [accessibility, initialScreenshotResult, diagnostics, timelines] = yield* Effect.all([
        send("Accessibility.getFullAXTree"),
        send("Page.captureScreenshot", {
          format: "png",
          fromSurface: false,
          captureBeyondViewport: false,
        }),
        Ref.get(diagnosticsRef),
        Ref.get(actionTimelineRef),
      ]);

      const hostScreenshot = yield* Effect.gen(function* () {
        const mainWindow = yield* Ref.get(mainWindowRef);

        if (Option.isNone(mainWindow) || mainWindow.value.isDestroyed()) return null;
        const host = mainWindow.value.webContents;

        if (host.isDestroyed()) return null;

        const tabIdJson = yield* encodeJson(
          { operation: "automationSnapshot.encodeTabId", tabId, webContentsId: wc.id },
          tabId,
        );

        const rawRect = yield* attemptPromise(
          {
            operation: "automationSnapshot.measureHostPreview",
            tabId,
            webContentsId: wc.id,
          },
          () =>
            host.executeJavaScript(`new Promise((resolve) => {
              const deadline = performance.now() + 3000;
              const measure = () => {
                const preview = Array.from(document.querySelectorAll("webview")).find(
                  (element) =>
                    element.getWebContentsId?.() === ${wc.id} ||
                    element.dataset.previewServerTab === ${tabIdJson}
                );
                if (preview) {
                  const style = getComputedStyle(preview);
                  const rect = preview.getBoundingClientRect();
                  if (
                    style.display !== "none" &&
                    style.visibility !== "hidden" &&
                    Number(style.opacity) !== 0 &&
                    rect.width > 0 &&
                    rect.height > 0 &&
                    rect.right > 0 &&
                    rect.bottom > 0 &&
                    rect.left < innerWidth &&
                    rect.top < innerHeight
                  ) {
                    resolve({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
                    return;
                  }
                }
                if (performance.now() >= deadline) {
                  resolve(null);
                  return;
                }
                requestAnimationFrame(measure);
              };
              measure();
            })`),
        ).pipe(
          Effect.timeout("4 seconds"),
          Effect.orElseSucceed(() => null),
        );

        const rect = normalizeCaptureRect(rawRect);

        if (!rect) return null;

        const captured = yield* attemptPromise(
          {
            operation: "automationSnapshot.captureHostPreview",
            tabId,
            webContentsId: wc.id,
          },
          () => host.capturePage(rect, { stayAwake: true }),
        ).pipe(Effect.orElseSucceed(() => null));

        if (captured && containsVisiblePngPixel(captured.toPNG())) return captured;

        const mediaSourceId = yield* attempt(
          {
            operation: "automationSnapshot.createTabCaptureSource",
            tabId,
            webContentsId: wc.id,
          },
          () => wc.getMediaSourceId(host),
        ).pipe(Effect.orElseSucceed(() => null));

        if (mediaSourceId) {
          const mediaSourceIdJson = yield* encodeJson(
            {
              operation: "automationSnapshot.encodeTabCaptureSource",
              tabId,
              webContentsId: wc.id,
            },
            mediaSourceId,
          );

          const tabCapture = yield* attemptPromise(
            {
              operation: "automationSnapshot.captureTabStream",
              tabId,
              webContentsId: wc.id,
            },
            () =>
              host.executeJavaScript(`(async () => {
                let stream;
                let expired = false;
                const stop = (value) => value?.getTracks().forEach((track) => track.stop());
                try {
                  const capture = navigator.mediaDevices.getUserMedia({
                    audio: false,
                    video: { mandatory: {
                      chromeMediaSource: "tab",
                      chromeMediaSourceId: ${mediaSourceIdJson}
                    }}
                  }).then((value) => {
                    if (!expired) return value;
                    stop(value);
                    throw new Error("Tab capture timed out");
                  });
                  stream = await Promise.race([
                    capture,
                    new Promise((_, reject) => setTimeout(() => {
                      expired = true;
                      reject(new Error("Tab capture timed out"));
                    }, 3000))
                  ]);
                  const video = document.createElement("video");
                  video.muted = true;
                  video.playsInline = true;
                  video.srcObject = stream;
                  await video.play();
                  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
                    await new Promise((resolve, reject) => {
                      const timer = setTimeout(() => reject(new Error("Tab frame timed out")), 3000);
                      video.addEventListener("loadeddata", () => {
                        clearTimeout(timer);
                        resolve();
                      }, { once: true });
                    });
                  }
                  const canvas = document.createElement("canvas");
                  canvas.width = video.videoWidth;
                  canvas.height = video.videoHeight;
                  const context = canvas.getContext("2d", { alpha: false });
                  if (!context || canvas.width <= 0 || canvas.height <= 0) {
                    throw new Error("Tab capture returned no frame");
                  }
                  context.drawImage(video, 0, 0);
                  return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
                } finally {
                  stop(stream);
                }
              })()`),
          ).pipe(
            Effect.timeout("4 seconds"),
            Effect.orElseSucceed(() => null),
          );

          if (Predicate.isString(tabCapture) && tabCapture.length > 0) {
            const tabData = Buffer.from(tabCapture, "base64");
            const tabImage = nativeImage.createFromBuffer(tabData);

            if (!tabImage.isEmpty() && containsVisiblePngPixel(tabData)) return tabImage;
          }
        }

        const windowBounds = mainWindow.value.getBounds();
        const contentBounds = mainWindow.value.getContentBounds();

        const sources = yield* attemptPromise(
          {
            operation: "automationSnapshot.captureDesktopWindow",
            tabId,
            webContentsId: wc.id,
          },
          () =>
            desktopCapturer.getSources({
              types: ["window"],
              thumbnailSize: { width: windowBounds.width, height: windowBounds.height },
            }),
        ).pipe(
          Effect.timeout("3 seconds"),
          Effect.orElseSucceed(() => []),
        );

        const source = sources.find(
          (candidate) => candidate.id === mainWindow.value.getMediaSourceId(),
        );

        if (!source || source.thumbnail.isEmpty()) return null;
        const thumbnailSize = source.thumbnail.getSize();
        const desktopRect = scaleCaptureRect(rect, windowBounds, contentBounds, thumbnailSize);

        if (
          desktopRect.x + desktopRect.width > thumbnailSize.width ||
          desktopRect.y + desktopRect.height > thumbnailSize.height
        ) {
          return null;
        }

        const desktopImage = source.thumbnail.crop(desktopRect);

        return !desktopImage.isEmpty() && containsVisiblePngPixel(desktopImage.toPNG())
          ? desktopImage
          : null;
      });

      const refreshedScreenshotResult = yield* send("Page.captureScreenshot", {
        format: "png",
        fromSurface: false,
        captureBeyondViewport: false,
      });

      const refreshedScreenshotData =
        Predicate.isObjectOrArray(refreshedScreenshotResult) &&
        refreshedScreenshotResult !== null &&
        "data" in refreshedScreenshotResult &&
        Predicate.isString(refreshedScreenshotResult.data)
          ? Buffer.from(refreshedScreenshotResult.data, "base64")
          : null;

      const hostScreenshotData = hostScreenshot?.toPNG() ?? null;

      const initialScreenshotData =
        Predicate.isObjectOrArray(initialScreenshotResult) &&
        initialScreenshotResult !== null &&
        "data" in initialScreenshotResult &&
        Predicate.isString(initialScreenshotResult.data)
          ? Buffer.from(initialScreenshotResult.data, "base64")
          : null;

      const fallbackScreenshotResult =
        refreshedScreenshotData && containsVisiblePngPixel(refreshedScreenshotData)
          ? refreshedScreenshotResult
          : hostScreenshotData && containsVisiblePngPixel(hostScreenshotData)
            ? { data: hostScreenshotData.toString("base64") }
            : initialScreenshotData && containsVisiblePngPixel(initialScreenshotData)
              ? initialScreenshotResult
              : null;

      const screencastScreenshotResult = fallbackScreenshotResult
        ? null
        : yield* Effect.gen(function* () {
            const screencastFrame = yield* Deferred.make<{ readonly data: string }>();

            const onScreencastMessage = (
              _event: Electron.Event,
              method: string,
              params: Record<string, Schema.Json | undefined>,
            ) => {
              if (method !== "Page.screencastFrame" || !Predicate.isString(params["data"])) return;
              const data = Buffer.from(params["data"], "base64");

              if (!containsVisiblePngPixel(data)) return;
              runFork(
                Deferred.succeed(screencastFrame, { data: params["data"] }).pipe(Effect.asVoid),
              );
            };

            return yield* Effect.acquireUseRelease(
              attempt(
                {
                  operation: "automationSnapshot.listenForScreencastFrame",
                  tabId,
                  webContentsId: wc.id,
                },
                () => wc.debugger.on("message", onScreencastMessage),
              ),
              () =>
                Effect.gen(function* () {
                  yield* send("Page.bringToFront");
                  yield* send("Page.startScreencast", {
                    format: "png",
                    maxWidth: MAX_SCREENSHOT_WIDTH,
                    everyNthFrame: 1,
                  });

                  return yield* Deferred.await(screencastFrame).pipe(Effect.timeout("3 seconds"));
                }).pipe(Effect.orElseSucceed(() => null)),
              () =>
                attempt(
                  {
                    operation: "automationSnapshot.removeScreencastListener",
                    tabId,
                    webContentsId: wc.id,
                  },
                  () => wc.debugger.off("message", onScreencastMessage),
                ).pipe(
                  Effect.ignore,
                  Effect.andThen(sendCleanup("Page.stopScreencast").pipe(Effect.ignore)),
                ),
            );
          });

      const screenshotResult =
        screencastScreenshotResult ?? fallbackScreenshotResult ?? initialScreenshotResult;

      const screenshot = yield* Effect.try({
        try: () => {
          if (
            !Predicate.isObjectOrArray(screenshotResult) ||
            screenshotResult === null ||
            !("data" in screenshotResult) ||
            !Predicate.isString(screenshotResult.data) ||
            screenshotResult.data.length === 0
          ) {
            throw new TypeError("Page.captureScreenshot returned no PNG data");
          }

          const sourceData = Buffer.from(screenshotResult.data, "base64");
          const image = nativeImage.createFromBuffer(sourceData);

          if (image.isEmpty()) {
            throw new TypeError("Page.captureScreenshot returned an invalid PNG");
          }

          if (!containsVisiblePngPixel(sourceData)) {
            throw new TypeError("Page.captureScreenshot returned an all-black PNG");
          }

          const sourceSize = image.getSize();

          if (
            !Number.isFinite(sourceSize.width) ||
            !Number.isFinite(sourceSize.height) ||
            sourceSize.width <= 0 ||
            sourceSize.height <= 0
          ) {
            throw new TypeError("Page.captureScreenshot returned invalid image dimensions");
          }

          const output =
            sourceSize.width > MAX_SCREENSHOT_WIDTH
              ? image.resize({ width: MAX_SCREENSHOT_WIDTH })
              : image;

          if (output.isEmpty()) {
            throw new TypeError("Page.captureScreenshot could not be resized");
          }

          const size = output.getSize();

          if (
            !Number.isFinite(size.width) ||
            !Number.isFinite(size.height) ||
            size.width <= 0 ||
            size.height <= 0
          ) {
            throw new TypeError("Page.captureScreenshot produced invalid output dimensions");
          }

          const data = sourceSize.width > MAX_SCREENSHOT_WIDTH ? output.toPNG() : sourceData;

          if (data.byteLength === 0) {
            throw new TypeError("Page.captureScreenshot produced an empty PNG");
          }

          return {
            mimeType: "image/png" as const,
            data: data.toString("base64"),
            width: size.width,
            height: size.height,
          };
        },
        catch: (cause) =>
          new PreviewOperationError({
            operation: "automationSnapshot.decodeScreenshot",
            tabId,
            webContentsId: wc.id,
            cause,
          }),
      });

      const browserDiagnostics = diagnostics.get(wc.id);

      return {
        ...page,
        accessibilityTree: accessibility,
        consoleEntries: [...(browserDiagnostics?.consoleEntries ?? [])],
        networkEntries: [...(browserDiagnostics?.networkEntries ?? [])],
        actionTimeline: [...(timelines.get(tabId) ?? [])],
        screenshot,
      };
    },
  );

  const automationSnapshot = Effect.fn("PreviewManager.automationSnapshot")(function* (
    tabId: string,
  ) {
    const wc = yield* requireWebContents(tabId);

    return yield* withControlSession(tabId, wc, "snapshot", (send, sendCleanup) =>
      captureAutomationSnapshot(tabId, wc, send, sendCleanup),
    );
  });

  return { automationLocator, automationSelectorDiagnostics, automationSnapshot };
};
