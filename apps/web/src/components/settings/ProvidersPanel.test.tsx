import { renderToStaticMarkup } from "react-dom/server";
import type { SubscriptionProviderStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { LanguageProvider } from "../../i18n";
import { ProviderAccountRows, ProviderApiKeyForm, SUBSCRIPTION_PROVIDERS } from "./ProvidersPanel";

describe("subscription providers", () => {
  it("offers Kimi subscription login without Cursor", () => {
    const providers = SUBSCRIPTION_PROVIDERS.map((provider) => provider.id);
    expect(providers).toContain("kimi-for-coding");
    expect(providers).toContain("opencode-go");
    expect(providers).not.toContain("cursor");
  });

  it("offers OpenCode Go without the standard OpenCode CLI", async () => {
    const { PROVIDER_CATALOG } = await import("./providerCatalog");
    const { DRIVER_OPTIONS } = await import("./providerDriverMeta");
    expect(PROVIDER_CATALOG.map((entry) => entry.slug)).toContain("opencode-go");
    expect(PROVIDER_CATALOG.map((entry) => entry.slug)).not.toContain("opencode");
    expect(DRIVER_OPTIONS.map((option) => option.value)).toContain("opencodeGo");
    expect(DRIVER_OPTIONS.map((option) => option.value)).not.toContain("opencode");
  });

  it("masks API keys and offers an optional endpoint with save and cancel", () => {
    const markup = renderToStaticMarkup(
      <ProviderApiKeyForm
        apiKey=""
        baseUrl=""
        busy={false}
        error="The key was not saved."
        onKeyChange={() => undefined}
        onBaseUrlChange={() => undefined}
        onSave={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(markup).toContain('type="password"');
    expect(markup).toContain('autoComplete="off"');
    expect(markup).toContain("Base URL (optional)");
    expect(markup).toContain("Save");
    expect(markup).toContain("Cancel");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("The key was not saved.");
    expect(markup).toMatch(/type="submit"[^>]*disabled/);
  });

  it("identifies saved keys and provides both key reconnect and OAuth switching", () => {
    const markup = renderToStaticMarkup(
      <ProviderAccountRows
        definition={SUBSCRIPTION_PROVIDERS[1]!}
        status={{
          provider: "anthropic",
          authMode: "api-key",
          baseUrl: "https://proxy.example/v1",
          connected: true,
          accountLabel: "dev@example.com",
          health: "detected",
          dependentBots: [],
          dependentRoutines: [],
        }}
        busy={false}
        onConnect={() => undefined}
        onApiKey={() => undefined}
        onDisconnect={() => undefined}
        onTest={() => undefined}
      />,
    );
    expect(markup).toContain("Check key");
    expect(markup).toContain("Connected account");
    expect(markup).toContain("dev@example.com");
    expect(markup).not.toContain("Check OAuth");
    expect(markup).toContain("Saved · https://proxy.example/v1");
    expect(markup).toContain("Replace key");
    expect(markup).toContain("Use OAuth");
    expect(markup).toContain("Disconnect Claude");
    expect(markup).not.toContain("Detected");
    expect(markup).not.toContain(SUBSCRIPTION_PROVIDERS[1]!.description);
  });

  it("disables other providers without showing false progress", () => {
    const markup = renderToStaticMarkup(
      <ProviderAccountRows
        definition={SUBSCRIPTION_PROVIDERS[0]!}
        status={undefined}
        busy={false}
        disabled
        onConnect={() => undefined}
        onApiKey={() => undefined}
        onDisconnect={() => undefined}
        onTest={() => undefined}
      />,
    );
    expect(markup).toContain("disabled");
    expect(markup).toContain("Connect");
    expect(markup).toContain("Add key");
    expect(markup).not.toContain("Disconnect");
    expect(markup).not.toContain("animate-spin");
  });

  it("does not offer a custom endpoint for Grok", () => {
    const markup = renderToStaticMarkup(
      <ProviderApiKeyForm
        supportsBaseUrl={false}
        apiKey=""
        baseUrl=""
        busy={false}
        error={null}
        onKeyChange={() => undefined}
        onBaseUrlChange={() => undefined}
        onSave={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(markup).not.toContain("Base URL");
    expect(markup).toContain("Grok uses its default endpoint.");
    expect(markup).toContain('type="password"');
  });

  it("disables both form actions while saving", () => {
    const markup = renderToStaticMarkup(
      <ProviderApiKeyForm
        apiKey="test-key"
        baseUrl="https://proxy.example"
        busy
        error={null}
        onKeyChange={() => undefined}
        onBaseUrlChange={() => undefined}
        onSave={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(markup).toContain("Saving…");
    expect(markup).toMatch(/type="submit"[^>]*disabled/);
    expect(markup).toMatch(/type="button"[^>]*disabled/);
  });

  it("names an account problem without the raw failure message", () => {
    const status: SubscriptionProviderStatus = {
      provider: "openai-codex",
      connected: true,
      health: "failed-first-request",
      lastSuccessfulRequestAt: "2026-09-01T10:00:00.000Z",
      lastFailedRequest: {
        at: "2026-09-01T10:01:00.000Z",
        message: "Provider request failed.",
      },
      dependentBots: [],
      dependentRoutines: [],
    };
    const markup = renderToStaticMarkup(
      <ProviderAccountRows
        definition={SUBSCRIPTION_PROVIDERS[0]!}
        status={status}
        busy={false}
        onConnect={() => undefined}
        onApiKey={() => undefined}
        onDisconnect={() => undefined}
        onTest={() => undefined}
      />,
    );

    expect(markup).toContain("Disconnect ChatGPT");
    expect(markup).toContain("Reconnect");
    expect(markup).toContain("First request failed");
    expect(markup).not.toContain("Last successful request");
    expect(markup).not.toContain("Last failed request");
    expect(markup).not.toContain("Provider request failed.");
  });
});
