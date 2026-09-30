import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const browser = vi.hoisted(() => ({ enabled: false, browserbaseApiKeyRedacted: false }));
vi.mock("~/hooks/useSettings", () => ({
  usePrimarySettings: () => ({ browserProvider: browser }),
  useUpdatePrimarySettings: () => vi.fn(),
}));

import { BrowserSettingsSection } from "./BrowserSettings";

describe("Browser settings", () => {
  it("requires a saved key before enabling hosted browsing", () => {
    browser.enabled = false;
    browser.browserbaseApiKeyRedacted = false;
    const markup = renderToStaticMarkup(<BrowserSettingsSection />);
    expect(markup).toContain("API key required");
    expect(markup).toMatch(/<span data-disabled=""[^>]*role="switch"/);

    browser.browserbaseApiKeyRedacted = true;
    const configuredMarkup = renderToStaticMarkup(<BrowserSettingsSection />);
    expect(configuredMarkup).toContain("Configured");
    expect(configuredMarkup).not.toMatch(/<span data-disabled=""[^>]*role="switch"/);
  });
});
