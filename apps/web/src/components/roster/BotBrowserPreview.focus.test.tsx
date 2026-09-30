// @effect-diagnostics nodeBuiltinImport:off - The focus contract reads its source.
import * as NodeFS from "node:fs";

import { EnvironmentId, ThreadId } from "@akeru/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../preview/usePreviewSession", () => ({ usePreviewSession: vi.fn() }));
vi.mock("../preview/PreviewPanel", () => ({
  PreviewPanel: () => <div data-testid="native-preview-panel" />,
}));
vi.mock("../../browser/BrowserSurfaceSlot", () => ({
  BrowserSurfaceSlot: () => <div data-testid="native-browser-surface" />,
}));
vi.mock("../../previewStateStore", () => ({
  isPreviewSupportedInRuntime: () => false,
  useThreadPreviewState: () => ({
    activeTabId: "tab-1",
    serverEpoch: "epoch-1",
    sessions: { "tab-1": { navStatus: { _tag: "Success", url: "https://x.test", title: "X" } } },
    desktopByTabId: {},
    framesByTabId: { "tab-1": { mimeType: "image/png", data: "frame", width: 10, height: 10 } },
  }),
}));

import { BotBrowserPreview } from "./BotBrowserPreview";

/*
 * The unit project runs in node with no DOM, and neither jsdom nor happy-dom is
 * installed, so focus movement itself cannot be exercised here. These assert the
 * two halves that are checkable: the focus targets exist in the rendered markup,
 * and the effect that moves focus between them exists in the source.
 */

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

const render = (expanded: boolean) =>
  renderToStaticMarkup(
    <BotBrowserPreview
      botName="Akeru"
      threadRef={threadRef}
      expanded={expanded}
      visible
      onExpandedChange={vi.fn()}
    />,
  );

describe("BotBrowserPreview focus targets", () => {
  it("marks the expand control so collapsing can restore it", () => {
    expect(render(false)).toContain("data-browser-expand");
  });

  it("makes the expanded view focusable so focus can travel into it", () => {
    const markup = render(true);
    expect(markup).toContain('data-testid="bot-browser-expanded"');
    expect(markup).toContain('tabindex="-1"');
  });

  it("moves focus into the expanded view and restores the trigger on collapse", () => {
    const source = NodeFS.readFileSync(new URL("./BotBrowserPreview.tsx", import.meta.url), "utf8");

    expect(source).toContain("expandedRef.current?.focus()");
    expect(source).toContain('querySelector<HTMLElement>("[data-browser-expand]")?.focus()');
    expect(source).toContain("wasExpanded");
  });
});
