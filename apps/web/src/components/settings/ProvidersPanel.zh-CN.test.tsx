import { catalogRegistry } from "@akeru/client-runtime/i18n";
import type { SubscriptionProviderStatus } from "@akeru/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { LanguageProvider } from "../../i18n";
import { ProviderAccountRows, SUBSCRIPTION_PROVIDERS } from "./ProvidersPanel";

const zhCNCatalog = await catalogRegistry["zh-CN"]!();

describe("provider account rows in Simplified Chinese", () => {
  it("translates the account rows and their actions", () => {
    const status: SubscriptionProviderStatus = {
      provider: "openai-codex",
      connected: true,
      health: "healthy",
      accountLabel: "person@example.com",
      dependentBots: [],
      dependentRoutines: [],
    };
    const html = renderToStaticMarkup(
      <LanguageProvider testCatalog={{ locale: "zh-CN", catalog: zhCNCatalog }}>
        <ProviderAccountRows
          definition={SUBSCRIPTION_PROVIDERS[0]!}
          status={status}
          busy={false}
          onConnect={() => undefined}
          onApiKey={() => undefined}
          onDisconnect={() => undefined}
          onTest={() => undefined}
        />
      </LanguageProvider>,
    );
    for (const label of ["已连接的账户", "订阅", "检查", "从此环境中移除已保存的凭据。"]) {
      expect(html).toContain(label);
    }
    for (const label of ["Connected account", "Subscription", "Remove the saved credentials"]) {
      expect(html).not.toContain(label);
    }
    expect(html).toContain("person@example.com");
  });
});
