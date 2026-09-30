import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { BotBrowserPreview, isLiveBrowserStatus } from "./BotBrowserPreview";

const mocks = vi.hoisted(() => ({ nativeSupported: false }));

vi.mock("../preview/usePreviewSession", () => ({ usePreviewSession: vi.fn() }));
vi.mock("../preview/PreviewPanel", () => ({
  PreviewPanel: () => <div data-testid="native-preview-panel" />,
}));
vi.mock("../../browser/BrowserSurfaceSlot", () => ({
  BrowserSurfaceSlot: () => <div data-testid="native-browser-surface" />,
}));
vi.mock("../../previewStateStore", () => ({
  isPreviewSupportedInRuntime: () => mocks.nativeSupported,
  useThreadPreviewState: () => ({
    activeTabId: "tab-1",
    serverEpoch: "epoch-1",
    sessions: {
      "tab-1": {
        navStatus: { _tag: "Success", url: "https://example.com", title: "Example" },
      },
    },
    desktopByTabId: {},
    framesByTabId: {
      "tab-1": {
        mimeType: "image/png",
        data: "remote-frame",
        width: 1280,
        height: 800,
      },
    },
  }),
}));

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

beforeEach(() => {
  mocks.nativeSupported = false;
});

describe("BotBrowserPreview", () => {
  it("treats only a page-bearing status as live", () => {
    expect(isLiveBrowserStatus("ready")).toBe(true);
    expect(isLiveBrowserStatus("loading")).toBe(true);
    expect(isLiveBrowserStatus("waiting")).toBe(false);
    expect(isLiveBrowserStatus("failed")).toBe(false);
    expect(isLiveBrowserStatus("unsupported")).toBe(false);
  });

  it("stays hidden until the bot has a thread to show", () => {
    const markup = renderToStaticMarkup(
      <BotBrowserPreview
        botName="Akeru"
        threadRef={null}
        expanded={false}
        visible
        onExpandedChange={vi.fn()}
      />,
    );

    // A bot that has never run has no page yet, so the inline preview stays out of the way.
    expect(markup).toBe("");
  });

  it("goes dark and offers Open once a page is live", () => {
    const markup = renderToStaticMarkup(
      <BotBrowserPreview
        botName="Akeru"
        threadRef={threadRef}
        expanded={false}
        visible
        onExpandedChange={vi.fn()}
      />,
    );

    expect(markup).toContain("bg-zinc-950");
    expect(markup).toContain('data-testid="bot-browser-preview"');
    expect(markup).toContain('aria-label="Expand Akeru browser"');
    expect(markup).toContain('aria-label="Open Akeru browser"');
  });

  it("renders the remote frame when expanded on the web", () => {
    const markup = renderToStaticMarkup(
      <BotBrowserPreview
        botName="Akeru"
        threadRef={threadRef}
        expanded
        visible
        onExpandedChange={vi.fn()}
      />,
    );

    expect(markup).toContain('data-testid="bot-browser-remote-frame"');
    expect(markup).toContain("data:image/png;base64,remote-frame");
    expect(markup).toContain('aria-label="Collapse Akeru browser"');
    expect(markup).not.toContain("native-preview-panel");
    expect(markup).not.toContain("Preview is only available");
  });

  it("preserves the native preview panel when expanded in Electron", () => {
    mocks.nativeSupported = true;
    const markup = renderToStaticMarkup(
      <BotBrowserPreview
        botName="Akeru"
        threadRef={threadRef}
        expanded
        visible
        onExpandedChange={vi.fn()}
      />,
    );

    expect(markup).toContain('data-testid="native-preview-panel"');
    expect(markup).not.toContain('data-testid="bot-browser-remote-frame"');
  });
});
