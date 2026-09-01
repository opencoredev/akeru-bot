import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  resolveSidebarStageFocusRingOffsetClass,
  StageBackdropArt,
  StageBackdropButtonArt,
} from "./SidebarStageBackdrop";

describe("SidebarStageBackdrop", () => {
  it("resolves stage artwork only when enabled", () => {
    expect(resolveSidebarStageBackdropVariant("Dev")).toBe("dev");
    expect(resolveSidebarStageBackdropVariant("Nightly")).toBeNull();
    expect(resolveSidebarStageBackdropVariant("Dev", false)).toBeNull();
    expect(resolveSidebarStageBackdropVariant("Alpha")).toBeNull();
  });

  it("resolves supported environment pill labels", () => {
    expect(resolveEnvironmentIdentificationPillLabel("Dev")).toBe("Dev");
    expect(resolveEnvironmentIdentificationPillLabel("nightly")).toBeNull();
    expect(resolveEnvironmentIdentificationPillLabel("Latest")).toBeNull();
    expect(resolveEnvironmentIdentificationPillLabel("Alpha")).toBeNull();
  });

  it("matches the focus-ring offset to each artwork palette", () => {
    expect(resolveSidebarStageFocusRingOffsetClass("dev")).toBe(
      "focus-visible:ring-offset-(--stage-art-bottom)",
    );
  });

  it("uses unique SVG definition ids when artwork is rendered more than once", () => {
    const markup = renderToStaticMarkup(
      <>
        <StageBackdropArt variant="dev" />
        <StageBackdropArt variant="dev" />
      </>,
    );
    const ids = Array.from(markup.matchAll(/\sid="([^"]+)"/g), (match) => match[1]);

    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("paints each artwork variant with theme-owned color tokens", () => {
    const devMarkup = renderToStaticMarkup(<StageBackdropArt variant="dev" />);

    expect(devMarkup).toContain("var(--stage-art-bottom)");
    expect(devMarkup).toContain("var(--stage-art-line)");
    expect(devMarkup).not.toMatch(/#[0-9a-f]{3,8}/i);
  });

  it("uses the compact Dev crop inside the send button", () => {
    const markup = renderToStaticMarkup(<StageBackdropButtonArt variant="dev" />);

    expect(markup).toContain('viewBox="64 0 8192 96"');
    expect(markup).toContain("stage-blueprint");
  });
});
