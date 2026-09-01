import type { SubscriptionProviderStatus } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ProviderLoginCard, SUBSCRIPTION_PROVIDERS } from "./ProvidersPanel";

describe("subscription providers", () => {
  it("offers Kimi subscription login without Cursor", () => {
    const providers = SUBSCRIPTION_PROVIDERS.map((provider) => provider.id);
    expect(providers).toContain("kimi-for-coding");
    expect(providers).not.toContain("cursor");
  });

  it("keeps connected providers compact", () => {
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
      <ProviderLoginCard
        definition={SUBSCRIPTION_PROVIDERS[0]!}
        status={status}
        busy={false}
        onConnect={() => undefined}
        onDisconnect={() => undefined}
        onTest={() => undefined}
      />,
    );

    expect(markup).toContain("ChatGPT");
    expect(markup).toContain("Reconnect");
    expect(markup).not.toContain("Last successful request");
    expect(markup).not.toContain("Last failed request");
    expect(markup).not.toContain("Provider request failed.");
  });
});
