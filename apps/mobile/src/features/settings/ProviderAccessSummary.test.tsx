import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Pressable: ({
    accessibilityState,
    children,
  }: {
    readonly accessibilityState?: { readonly expanded?: boolean };
    readonly children?: ReactNode;
  }) => createElement("button", { "aria-expanded": accessibilityState?.expanded }, children),
  View: "div",
}));
vi.mock("../../components/AppText", () => ({ AppText: "span" }));
vi.mock("../../lib/i18n", async () => {
  const { createTranslator } = await import("@t3tools/client-runtime/i18n");
  const translator = createTranslator("en");
  return { useMobileI18n: () => ({ ...translator, t: translator.translate }) };
});

import { ProviderAccessSummary } from "./ProviderAccessSummary";

describe("ProviderAccessSummary", () => {
  it("shows the access state and next step with details folded", () => {
    const markup = renderToStaticMarkup(
      <ProviderAccessSummary
        provider="openai-codex"
        status={{ connected: true, health: "detected" }}
        models={["GPT-5.5"]}
      />,
    );
    expect(markup).toContain("Not verified yet.");
    expect(markup).toContain("Choose Check OAuth to send a health request.");
    expect(markup).toContain("Access details");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("does not include OpenAI API access");
  });

  it("shows the provider's failure text and a wait step while a check runs", () => {
    const failed = renderToStaticMarkup(
      <ProviderAccessSummary
        provider="xai"
        status={{
          connected: true,
          authMode: "api-key",
          health: "failed",
          lastFailedRequest: { at: "2026-09-25T00:00:00.000Z", message: "401 Unauthorized" },
        }}
      />,
    );
    expect(failed).toContain("Check failed.");
    expect(failed).toContain("401 Unauthorized");
    const checking = renderToStaticMarkup(
      <ProviderAccessSummary
        provider="xai"
        status={{ connected: true, health: "detected", healthChecking: true }}
      />,
    );
    expect(checking).toContain("Checking access.");
    expect(checking).toContain("Wait for the health check to finish.");
  });

  it("marks access ready only after a successful request and hides removed Cursor", () => {
    const markup = renderToStaticMarkup(
      <ProviderAccessSummary
        provider="anthropic"
        status={{ connected: true, health: "healthy" }}
      />,
    );
    expect(markup).toContain("Ready.");
    expect(markup).toContain("No action needed. A provider request succeeded.");
    expect(
      renderToStaticMarkup(<ProviderAccessSummary provider="cursor" status={undefined} />),
    ).toBe("");
  });
});
