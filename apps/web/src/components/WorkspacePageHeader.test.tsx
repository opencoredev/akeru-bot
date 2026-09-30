import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { WorkspacePageHeader, detailsToggleInsetClass } from "./WorkspacePageHeader";

const TOGGLE_INSET =
  "pr-[calc(var(--workspace-controls-right)+var(--workspace-titlebar-control-size)+var(--workspace-titlebar-control-gap))]!";

describe("detailsToggleInsetClass", () => {
  it("reserves the floating toggle at every width while the desktop panel is closed", () => {
    expect(detailsToggleInsetClass(false)).toBe(TOGGLE_INSET);
  });

  it("reserves it only below the inline breakpoint while the desktop panel is open", () => {
    expect(detailsToggleInsetClass(true)).toBe(`max-[980px]:${TOGGLE_INSET}`);
  });

  it("adds nothing on pages without a details panel", () => {
    expect(detailsToggleInsetClass(undefined)).toBeNull();
  });
});

describe("WorkspacePageHeader", () => {
  it("applies the toggle inset after the default right padding", () => {
    const markup = renderToStaticMarkup(<WorkspacePageHeader detailsPanelOpen={false} />);
    expect(markup).toContain(TOGGLE_INSET);
    expect(renderToStaticMarkup(<WorkspacePageHeader />)).not.toContain(
      "--workspace-controls-right",
    );
  });
});
