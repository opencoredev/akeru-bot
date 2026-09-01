import { renderToStaticMarkup } from "react-dom/server";
import { BotId, type ProviderAccessStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ProviderAccessSection,
  selectVisibleProviderAccess,
  SUBSCRIPTION_PROVIDERS,
} from "./ProvidersPanel";

function access(overrides: Partial<ProviderAccessStatus>): ProviderAccessStatus {
  return {
    id: "api-key-custom",
    label: "Custom API key",
    accessMethod: "api-key",
    health: "detected",
    apiAccess: "included",
    nextAction: "Send a provider request to verify the key.",
    dependentBots: [],
    dependentRoutines: [],
    ...overrides,
  };
}

describe("provider access rows", () => {
  it("offers Kimi subscription login without Cursor", () => {
    const providers = SUBSCRIPTION_PROVIDERS.map((provider) => provider.id);
    expect(providers).toContain("kimi-for-coding");
    expect(providers).not.toContain("cursor");
  });

  it("keeps non-subscription access and unsupported plan rows", () => {
    const visible = selectVisibleProviderAccess([
      access({ id: "chatgpt", accessMethod: "subscription-oauth" }),
      access({ id: "supergrok", accessMethod: "subscription-oauth", health: "unsupported" }),
      access({ id: "cursor-acp", accessMethod: "acp-cli" }),
      access({ id: "builtin-exa", accessMethod: "mcp" }),
      access({ id: "email-browser", accessMethod: "browser", health: "unsupported" }),
    ]);

    expect(visible.map((item) => item.id)).toEqual([
      "supergrok",
      "cursor-acp",
      "builtin-exa",
      "email-browser",
    ]);
  });

  it("renders repair instructions and dependent bots", () => {
    const markup = renderToStaticMarkup(
      <ProviderAccessSection
        access={[
          access({
            id: "email-browser",
            label: "Email browser session",
            accessMethod: "browser",
            health: "unsupported",
            repairAction: "Add an email connector.",
            dependentBots: [{ id: BotId.make("bot-1"), name: "Research bot" }],
          }),
        ]}
      />,
    );

    expect(markup).toContain("Email browser session");
    expect(markup).toContain("Unsupported");
    expect(markup).toContain("Add an email connector.");
    expect(markup).toContain("Research bot");
  });
});
