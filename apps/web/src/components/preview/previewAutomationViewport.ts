import {
  type EnvironmentId,
  type PreviewAutomationRequest,
  type PreviewRenderedViewportSize,
  type PreviewViewportSetting,
  type ScopedThreadRef,
} from "@akeru/contracts";
import {
  PreviewAutomationOverlayTimeoutError,
  PreviewAutomationViewportTimeoutError,
} from "./previewAutomationErrors";
import { previewBridge } from "./previewBridge";
import { assertPreviewRuntimeCurrent } from "./previewNavigationReadiness";
import { isPreviewViewportReady } from "./previewViewportReadiness";

export const waitForDesktopOverlay = async (
  threadRef: ScopedThreadRef,
  requestId: string,
  tabId: string,
  runtimeTabId: string,
  operation: PreviewAutomationRequest["operation"],
  timeoutMs: number,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const state = assertPreviewRuntimeCurrent(threadRef, tabId, runtimeTabId, {
      operation,
      requestId,
    });

    if (state.desktopByTabId[tabId] && previewBridge && isPreviewWebviewRendering(runtimeTabId)) {
      const status = await previewBridge.automation.status(runtimeTabId);

      if (status.available) return;
    }

    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
  }

  throw new PreviewAutomationOverlayTimeoutError({
    requestId,
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
    timeoutMs,
  });
};

interface ExecutablePreviewWebview extends Element {
  readonly executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
}

const findPreviewWebview = (tabId: string): ExecutablePreviewWebview | null =>
  Array.from(document.querySelectorAll<ExecutablePreviewWebview>("webview[data-preview-tab]")).find(
    (candidate) => candidate.getAttribute("data-preview-tab") === tabId,
  ) ?? null;

export const isPreviewWebviewRendering = (runtimeTabId: string): boolean => {
  const wrapper = findPreviewWebview(runtimeTabId)?.closest<HTMLElement>("[data-preview-viewport]");

  return wrapper?.getAttribute("data-preview-rendering") === "active";
};

const readWebviewViewport = async (
  webview: ExecutablePreviewWebview,
): Promise<PreviewRenderedViewportSize | null> => {
  const value = await webview.executeJavaScript(
    "({ width: window.innerWidth, height: window.innerHeight })",
  );

  if (typeof value !== "object" || value === null) return null;
  const { width, height } = value as { readonly width?: unknown; readonly height?: unknown };

  return typeof width === "number" &&
    Number.isInteger(width) &&
    width > 0 &&
    typeof height === "number" &&
    Number.isInteger(height) &&
    height > 0
    ? { width, height }
    : null;
};

export const readRenderedViewport = async (
  runtimeTabId: string,
): Promise<PreviewRenderedViewportSize | null> => {
  const webview = findPreviewWebview(runtimeTabId);

  if (!webview) return null;

  return await readWebviewViewport(webview);
};

const readDeclaredViewport = (
  webview: ExecutablePreviewWebview | null,
): PreviewRenderedViewportSize | null => {
  const width = Number(webview?.getAttribute("data-preview-css-width"));
  const height = Number(webview?.getAttribute("data-preview-css-height"));

  return Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0
    ? { width, height }
    : null;
};

export const waitForRenderedViewport = async (
  threadRef: ScopedThreadRef,
  tabId: string,
  runtimeTabId: string,
  setting: PreviewViewportSetting,
  timeoutMs: number,
  context: {
    readonly requestId: PreviewAutomationRequest["requestId"];
    readonly operation: PreviewAutomationRequest["operation"];
    readonly environmentId: EnvironmentId;
    readonly threadId: PreviewAutomationRequest["threadId"];
  },
): Promise<PreviewRenderedViewportSize> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    assertPreviewRuntimeCurrent(threadRef, tabId, runtimeTabId, context);

    try {
      const webview = findPreviewWebview(runtimeTabId);
      const appliedSettingKey = webview?.getAttribute("data-preview-viewport-key") ?? null;
      const declaredViewport = readDeclaredViewport(webview);
      const renderedViewport = webview ? await readWebviewViewport(webview) : null;

      if (
        renderedViewport &&
        isPreviewViewportReady({
          setting,
          appliedSettingKey,
          declaredViewport,
          renderedViewport,
        })
      ) {
        return renderedViewport;
      }
    } catch {
      // Registration and navigation can transiently replace the guest while
      // React applies the server snapshot. Retry until the operation deadline.
    }

    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
  }

  throw new PreviewAutomationViewportTimeoutError({
    ...context,
    tabId,
    timeoutMs,
  });
};
