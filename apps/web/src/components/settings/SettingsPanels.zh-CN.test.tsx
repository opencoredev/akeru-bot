import { catalogRegistry } from "@akeru/client-runtime/i18n";
import { EnvironmentId } from "@akeru/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@akeru/contracts/settings";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { LanguageProvider } from "../../i18n";

const environment = vi.hoisted(() => ({ id: null as string | null }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: ReactNode }) => children,
  useLocation: ({ select }: { select: (location: { pathname: string; hash: string }) => string }) =>
    select({ pathname: "/settings/appearance", hash: "" }),
  useNavigate: () => () => undefined,
}));
// Every atom read resolves to "no server data yet".
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => undefined }));
vi.mock("../../hooks/useSettings", async (importOriginal) => {
  const select = (selector?: (settings: typeof DEFAULT_UNIFIED_SETTINGS) => unknown) =>
    selector ? selector(DEFAULT_UNIFIED_SETTINGS) : DEFAULT_UNIFIED_SETTINGS;
  return {
    ...(await importOriginal<typeof import("../../hooks/useSettings")>()),
    usePrimarySettings: select,
    useEnvironmentSettings: (_environmentId: unknown, selector?: never) => select(selector),
    useUpdatePrimarySettings: () => () => undefined,
    useUpdateEnvironmentSettings: () => () => undefined,
  };
});
vi.mock("../../settingsDialogStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../settingsDialogStore")>()),
  useSettingsEnvironmentId: () => environment.id,
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => null,
  usePrimaryEnvironment: () => null,
  usePrimaryEnvironmentId: () => null,
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
vi.mock("../chat/ProviderModelPicker", () => ({ ProviderModelPicker: () => null }));
vi.mock("../chat/TraitsPicker", () => ({ TraitsPicker: () => null }));
// Font discovery reads a browser-only store; rows fall back to the plain family input.
vi.mock("./FontFamilyPicker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./FontFamilyPicker")>()),
  useFontEnumeration: () => ({ status: "unknown" }),
}));

import { ProviderDetailPage } from "./ProviderDetailPage";
import { ProviderInstancesSection } from "./ProviderInstancesSection";
import { PROVIDER_CATALOG } from "./providerCatalog";
import { SandboxSettingsPanel } from "./SandboxSettingsPanel";
import {
  AdvancedSettingsSections,
  AppearanceSettingsPanel,
  BotWorkspaceSettingsSection,
} from "./SettingsPanels";

const zhCNCatalog = await catalogRegistry["zh-CN"]!();
const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

function renderInChinese(children: ReactNode) {
  return renderToStaticMarkup(
    <LanguageProvider testCatalog={{ locale: "zh-CN", catalog: zhCNCatalog }}>
      {children}
    </LanguageProvider>,
  );
}

function expectTranslated(
  html: string,
  chinese: ReadonlyArray<string>,
  english: ReadonlyArray<string>,
) {
  for (const label of chinese) expect(html).toContain(label);
  for (const label of english) expect(html).not.toContain(label);
}

describe("settings panels in Simplified Chinese", () => {
  beforeEach(() => {
    environment.id = null;
  });

  it("translates the Appearance panel", () => {
    expectTranslated(
      renderInChinese(<AppearanceSettingsPanel />),
      ["显示", "字体排版", zhCNCatalog["Glass opacity"]!, zhCNCatalog["Interface font"]!],
      [">Display<", ">Typography<", "Glass opacity", "Interface font", "Reset to default"],
    );
  });

  it("translates the Workspace and Advanced sections", () => {
    expectTranslated(
      renderInChinese(
        <>
          <BotWorkspaceSettingsSection />
          <AdvancedSettingsSections />
        </>,
      ),
      [zhCNCatalog["Workspace"]!, "后台工作", "故障排除", zhCNCatalog["Feedback endpoint"]!],
      [
        ">Workspace<",
        "Background work",
        "Troubleshooting",
        "Feedback endpoint",
        "View diagnostics",
      ],
    );
  });

  it("translates the Sandbox panel without an environment", () => {
    expectTranslated(
      renderInChinese(<SandboxSettingsPanel />),
      [zhCNCatalog["Sandbox"]!, zhCNCatalog["Connect to an environment first."]!],
      [">Sandbox<", "Connect to an environment first."],
    );
  });

  it("translates the Sandbox panel providers", () => {
    environment.id = ENVIRONMENT_ID;
    expectTranslated(
      renderInChinese(<SandboxSettingsPanel />),
      ["沙盒提供商", zhCNCatalog["Default sandbox"]!, zhCNCatalog["Not connected"]!],
      ["Sandbox providers", "Default sandbox", "Not connected", ">Connect<"],
    );
  });

  it("translates the provider detail page without an environment", () => {
    expectTranslated(
      renderInChinese(<ProviderDetailPage entry={PROVIDER_CATALOG[0]!} />),
      ["账户", zhCNCatalog["Unavailable"]!, zhCNCatalog["Providers"]!],
      [">Account<", ">Unavailable<", ">Providers<", "Connect to an environment"],
    );
  });

  it("translates the provider detail page and its instances", () => {
    environment.id = ENVIRONMENT_ID;
    expectTranslated(
      renderInChinese(<ProviderDetailPage entry={PROVIDER_CATALOG[0]!} />),
      [">配置<", "添加实例", "刷新 ChatGPT 状态", ">刷新<"],
      [">Configuration<", "Add instance", ">Refresh<", "Refresh ChatGPT status"],
    );
  });

  it("translates the missing runtime message in the instances section", () => {
    expectTranslated(
      renderInChinese(
        <ProviderInstancesSection
          environmentId={ENVIRONMENT_ID}
          drivers={[]}
          providerLabel="Example"
        />,
      ),
      [
        ">配置<",
        zhCNCatalog[
          "This environment has no {provider} runtime. Update the environment server to configure it here."
        ]!.replace("{provider}", "Example"),
      ],
      [">Configuration<", "This environment has no", "Add instance"],
    );
  });
});
