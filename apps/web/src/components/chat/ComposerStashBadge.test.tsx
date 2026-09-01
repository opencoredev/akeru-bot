import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerStashBadge } from "./ComposerStashBadge";

describe("ComposerStashBadge", () => {
  it("renders as a compact composer banner tab", () => {
    const markup = renderToStaticMarkup(
      <ComposerStashBadge
        count={3}
        menuOpen={false}
        pulseKey={0}
        pulsing={false}
        onToggleMenu={() => {}}
      />,
    );

    expect(markup).toContain('data-composer-banner-surface="attached"');
    expect(markup).toContain('data-composer-shoulder-tab="true"');
    expect(markup).toContain('data-prompt-stash-badge="true"');
    expect(markup).toContain("Stash");
    expect(markup).toContain("Stashed prompts: 3. Open stash.");
    expect(markup).toContain('aria-expanded="false"');
  });

  it("reports when the stash drawer is open", () => {
    const markup = renderToStaticMarkup(
      <ComposerStashBadge
        count={3}
        menuOpen
        pulseKey={0}
        pulsing={false}
        onToggleMenu={() => {}}
      />,
    );

    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("text-foreground");
    expect(markup).toContain("pointer-events-none");
    expect(markup).not.toContain("invisible");
  });

  it("keeps a compact inline entry point when a drawer occupies the tab", () => {
    const markup = renderToStaticMarkup(
      <ComposerStashBadge
        count={3}
        menuOpen
        placement="inline"
        pulseKey={0}
        pulsing={false}
        onToggleMenu={() => {}}
      />,
    );

    expect(markup).toContain('data-slot="button"');
    expect(markup).toContain("rounded-sm");
    expect(markup).toContain("focus-visible:ring-2");
    expect(markup).toContain("pointer-coarse:after:min-h-11");
    expect(markup).toContain("Stashed prompts: 3. Open stash.");
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).not.toContain('data-composer-banner-surface="attached"');
    expect(markup).not.toContain(" pointer-events-none ");
  });
});
