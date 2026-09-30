import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { DesktopUpdateStatusIcon } from "./DesktopUpdateStatusIcon";

describe("DesktopUpdateStatusIcon", () => {
  it("keeps the available state at the same scale as neighboring sidebar icons", () => {
    const markup = renderToStaticMarkup(<DesktopUpdateStatusIcon status="available" />);

    expect(markup).toContain("size-4");
    expect(markup).not.toContain("rounded-full");
  });

  it("keeps download progress inside the icon instead of filling the button hit target", () => {
    const markup = renderToStaticMarkup(
      <DesktopUpdateStatusIcon downloadPercent={42} status="downloading" />,
    );

    expect(markup).toContain("size-5");
    expect(markup).toContain('viewBox="0 0 20 20"');
    expect(markup).not.toContain("size-8");
  });

  it("uses the sidebar surface behind the downloaded check badge", () => {
    const markup = renderToStaticMarkup(<DesktopUpdateStatusIcon status="downloaded" />);

    expect(markup).toContain("ring-sidebar");
    expect(markup).toContain("text-sidebar");
    expect(markup).not.toContain("ring-background");
  });
});
