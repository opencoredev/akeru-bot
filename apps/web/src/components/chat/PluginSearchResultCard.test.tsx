import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PluginSearchResultCard } from "./PluginSearchResultCard";

describe("PluginSearchResultCard", () => {
  it("shows only the top matching plugin", () => {
    const markup = renderToStaticMarkup(
      <PluginSearchResultCard
        result={{
          kind: "plugin-search-results",
          query: "email",
          total: 3,
          sources: { directory: "available", composio: "setup-required" },
          recommendations: [
            {
              id: "gmail",
              source: "directory",
              name: "Gmail",
              description: "Email and inbox",
              action: "connect",
              logoUrl: "https://logos.composio.dev/api/gmail",
            },
            {
              id: "composio:slack",
              source: "composio",
              name: "Slack",
              description: "Messages and channels",
              action: "connect",
            },
            {
              id: "composio:notion",
              source: "composio",
              name: "Notion",
              description: "Pages and databases",
              action: "connect",
              logoUrl: "https://logos.composio.dev/api/notion",
            },
          ],
        }}
      />,
    );

    expect(markup).toContain("Gmail");
    expect(markup).not.toContain("Slack");
    expect(markup).not.toContain("Notion");
    expect(markup).toContain("Composio");
    expect(markup).not.toContain("Email and inbox");
    expect(markup).toContain("Set up Gmail");
    expect(markup).toContain("Set up Composio first");
    expect(markup).toContain('aria-label="Gmail plugin"');
    expect(markup).not.toContain("Suggested");
    expect(markup).not.toContain("View all");
    expect(markup).not.toContain("Browse plugins");
    expect(markup).not.toContain(">Akeru<");
  });

  it("uses the Composio logo endpoint when the top result omits a logo", () => {
    const markup = renderToStaticMarkup(
      <PluginSearchResultCard
        result={{
          kind: "plugin-search-results",
          query: "slack",
          total: 1,
          sources: { directory: "available", composio: "available" },
          recommendations: [
            {
              id: "composio:slack",
              source: "composio",
              name: "Slack",
              description: "Messages and channels",
              action: "connect",
            },
          ],
        }}
      />,
    );

    expect(markup).toContain("https://logos.composio.dev/api/slack");
  });

  it("disables unavailable plugin cards", () => {
    const markup = renderToStaticMarkup(
      <PluginSearchResultCard
        result={{
          kind: "plugin-search-results",
          query: "local only",
          total: 1,
          sources: { directory: "available", composio: "unavailable" },
          recommendations: [
            {
              id: "local-only",
              source: "directory",
              name: "Local only",
              description: "Requires a local service",
              action: "unavailable",
            },
          ],
        }}
      />,
    );

    expect(markup).toContain('aria-label="Unavailable Local only"');
    expect(markup).toContain("disabled");
    expect(markup).not.toContain("Open Local only");
  });

  it("shows a connected plugin with a manage action", () => {
    const markup = renderToStaticMarkup(
      <PluginSearchResultCard
        result={{
          kind: "plugin-search-results",
          query: "gmail",
          total: 1,
          sources: { directory: "available", composio: "available" },
          recommendations: [
            {
              id: "composio:gmail",
              source: "composio",
              name: "Gmail",
              description: "Email and inbox",
              action: "open",
              logoUrl: "https://logos.composio.dev/api/gmail",
            },
          ],
        }}
      />,
    );

    expect(markup).toContain("Connected");
    expect(markup).toContain('aria-label="Manage Gmail"');
    expect(markup).not.toContain("Email and inbox");
  });
});
