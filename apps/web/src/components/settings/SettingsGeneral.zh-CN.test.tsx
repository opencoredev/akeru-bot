import { catalogRegistry } from "@akeru/client-runtime/i18n";
import { DEFAULT_UNIFIED_SETTINGS } from "@akeru/contracts/settings";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { LanguageProvider } from "../../i18n";
import { SidebarProvider } from "../ui/sidebar";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useLocation: ({ select }: { select: (location: { pathname: string; hash: string }) => string }) =>
    select({ pathname: "/settings/general", hash: "" }),
  useNavigate: () => () => undefined,
}));
vi.mock("../../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useSettings")>()),
  usePrimarySettings: () => DEFAULT_UNIFIED_SETTINGS,
  useUpdatePrimarySettings: () => () => undefined,
}));
vi.mock("../sidebar/SidebarChrome", () => ({ SidebarChromeHeader: () => null }));

import { GeneralSettingsPanel } from "./GeneralSettingsPanel";
import { SettingsSidebarNav } from "./SettingsSidebarNav";

// The shipped catalog, loaded the same way the language selector loads it.
const zhCNCatalog = await catalogRegistry["zh-CN"]!();

function renderInChinese(children: ReactNode) {
  return renderToStaticMarkup(
    <LanguageProvider testCatalog={{ locale: "zh-CN", catalog: zhCNCatalog }}>
      {children}
    </LanguageProvider>,
  );
}

describe("settings in Simplified Chinese", () => {
  it("translates the settings rail", () => {
    const html = renderInChinese(
      <SidebarProvider>
        <SettingsSidebarNav />
      </SidebarProvider>,
    );
    for (const label of ["通用", "隐私与数据", "高级", "外观", "提供商", "返回聊天"]) {
      expect(html).toContain(label);
    }
    for (const label of ["Privacy &amp; data", "Appearance", "Back to chats"]) {
      expect(html).not.toContain(label);
    }
  });

  it("translates General row titles, descriptions, and select values", () => {
    const html = renderInChinese(<GeneralSettingsPanel />);
    for (const label of [
      "语言",
      "时间格式",
      "系统默认会跟随浏览器或操作系统的时钟偏好。",
      "用量刷新",
      "5 分钟",
      "版本",
      "发送反馈",
    ]) {
      expect(html).toContain(label);
    }
    for (const label of [
      "Time format",
      "System default follows",
      "Usage refresh",
      "reloads plan limits",
      "Send feedback",
    ]) {
      expect(html).not.toContain(label);
    }
    // Anchor ids stay stable for Settings search.
    expect(html).toContain('id="time-format"');
  });
});
