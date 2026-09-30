import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SidebarMenu, SidebarProvider } from "../ui/sidebar";
import { SidebarUtilityItem } from "./SidebarChrome";

function renderFooterDestination(label: string): string {
  return renderToStaticMarkup(
    <SidebarProvider>
      <SidebarMenu>
        <SidebarUtilityItem icon={null} label={label} onClick={() => undefined} />
      </SidebarMenu>
    </SidebarProvider>,
  );
}

describe("sidebar footer destinations", () => {
  it("renders the destination name as visible text rather than a bare glyph", () => {
    // The footer used to be four unlabeled icons, so the visible name is the
    // behavior under test: an accessible name alone would not bring it back.
    expect(renderFooterDestination("Usage")).toContain(">Usage<");
  });

  it("keeps an accessible name on the control", () => {
    expect(renderFooterDestination("Feedback")).toContain('aria-label="Feedback"');
  });
});
