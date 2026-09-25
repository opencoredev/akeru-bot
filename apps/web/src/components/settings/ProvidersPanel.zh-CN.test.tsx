import { catalogRegistry } from "@t3tools/client-runtime/i18n";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { EnvironmentId } from "@t3tools/contracts";

import { LanguageProvider } from "../../i18n";
import { DEFAULT_DESKTOP_ONBOARDING_DRAFT } from "../onboarding/desktopOnboarding.logic";

vi.mock("@tanstack/react-router", () => ({
  useLocation: ({ select }: { select: (location: { pathname: string; hash: string }) => string }) =>
    select({ pathname: "/settings/providers", hash: "" }),
  useNavigate: () => () => undefined,
}));
// No environment is selected, so the panel renders every provider as not connected.
vi.mock("../../settingsDialogStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../settingsDialogStore")>()),
  useSettingsEnvironmentId: () => null,
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: undefined,
    error: null,
    isPending: false,
    refresh: () => undefined,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => () => undefined }));
vi.mock("../../state/server", () => ({ serverEnvironment: { subscriptionAuth: () => ({}) } }));

import {
  ProviderApiKeyForm,
  ProviderLoginCard,
  ProvidersPanel,
  SUBSCRIPTION_PROVIDERS,
} from "./ProvidersPanel";
import { SubscriptionStep } from "../onboarding/DesktopOnboarding";

const zhCNCatalog = await catalogRegistry["zh-CN"]!();

function renderInChinese(children: ReactNode) {
  return renderToStaticMarkup(
    <LanguageProvider testCatalog={{ locale: "zh-CN", catalog: zhCNCatalog }}>
      {children}
    </LanguageProvider>,
  );
}

const noop = () => undefined;

describe("providers settings in Simplified Chinese", () => {
  it("translates the page heading, intro, and unconnected provider cards", () => {
    const html = renderInChinese(<ProvidersPanel />);
    for (const label of [
      "提供商",
      "连接订阅或 API 密钥。凭据会保留在此环境中。",
      "未连接",
      "通过 Codex 模型使用你的 ChatGPT 订阅。",
      "Pro 或 Max",
    ]) {
      expect(html).toContain(label);
    }
    for (const label of [
      ">Providers<",
      "Missing",
      ">Connect<",
      ">API key<",
      "Credentials stay on this environment",
      "Use your ChatGPT subscription",
    ]) {
      expect(html).not.toContain(label);
    }
  });

  it("translates a saved API key card", () => {
    const html = renderInChinese(
      <ProviderLoginCard
        definition={SUBSCRIPTION_PROVIDERS[1]!}
        status={{
          provider: "anthropic",
          authMode: "api-key",
          baseUrl: "https://proxy.example/v1",
          connected: true,
          health: "detected",
          dependentBots: [],
          dependentRoutines: [],
        }}
        busy={false}
        onConnect={noop}
        onApiKey={noop}
        onDisconnect={noop}
        onTest={noop}
      />,
    );
    expect(html).toContain("已保存 API 密钥 · https://proxy.example/v1");
    expect(html).toContain("断开 Claude 的连接");
    for (const label of [
      "API key saved",
      "Reconnect key",
      "Check key",
      "Use OAuth",
      "Disconnect",
    ]) {
      expect(html).not.toContain(label);
    }
  });

  it("translates the API key form", () => {
    const html = renderInChinese(
      <ProviderApiKeyForm
        apiKey=""
        baseUrl=""
        busy={false}
        error={null}
        onKeyChange={noop}
        onBaseUrlChange={noop}
        onSave={noop}
        onCancel={noop}
      />,
    );
    for (const label of ["Paste the API key", "Base URL", ">Save<", ">Cancel<"]) {
      expect(html).not.toContain(label);
    }
  });

  it("translates the plan line on the onboarding provider cards", () => {
    const html = renderInChinese(
      <SubscriptionStep
        environmentId={EnvironmentId.make("environment-1")}
        draft={DEFAULT_DESKTOP_ONBOARDING_DRAFT}
        onChange={noop}
        onContinue={noop}
      />,
    );
    for (const label of ["Plus、Pro、Business、Enterprise 或 Edu", "Pro 或 Max", "共享 xAI 登录"]) {
      expect(html).toContain(label);
    }
    for (const label of ["Pro or Max", "Shared xAI login", "Kimi For Coding plan"]) {
      expect(html).not.toContain(label);
    }
  });
});
