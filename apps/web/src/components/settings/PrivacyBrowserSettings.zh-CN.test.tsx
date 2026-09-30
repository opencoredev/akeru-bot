import { catalogRegistry } from "@akeru/client-runtime/i18n";
import { DEFAULT_UNIFIED_SETTINGS } from "@akeru/contracts/settings";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { LanguageProvider } from "../../i18n";

vi.mock("~/hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/hooks/useSettings")>()),
  usePrimarySettings: () => DEFAULT_UNIFIED_SETTINGS,
  useUpdatePrimarySettings: () => () => undefined,
}));
vi.mock("@tanstack/react-router", () => ({
  useLocation: ({ select }: { select: (location: { pathname: string; hash: string }) => string }) =>
    select({ pathname: "/settings/privacy", hash: "" }),
  useNavigate: () => () => undefined,
}));
vi.mock("./PortabilitySettings", () => ({ PortabilitySettings: () => null }));

import { BrowserSettingsSection } from "./BrowserSettings";
import { PrivacySettingsPanel } from "./PrivacySettings";

const zhCNCatalog = await catalogRegistry["zh-CN"]!();

function renderInChinese(children: ReactNode) {
  return renderToStaticMarkup(
    <LanguageProvider testCatalog={{ locale: "zh-CN", catalog: zhCNCatalog }}>
      {children}
    </LanguageProvider>,
  );
}

describe("privacy and browser settings in Simplified Chinese", () => {
  it("translates Privacy sections, rows, and policy links", () => {
    const html = renderInChinese(<PrivacySettingsPanel />);
    for (const label of ["数据共享", "发送匿名分析数据", "备份与迁移", "桌面端更新", "政策"]) {
      expect(html).toContain(label);
    }
    for (const label of ["Data sharing", "Backup and transfer", "Desktop updates", "Policies"]) {
      expect(html).not.toContain(label);
    }
  });

  it("translates Browser rows and status labels", () => {
    const html = renderInChinese(<BrowserSettingsSection />);
    for (const label of ["需要 API 密钥", "智能体浏览器访问", "浏览器使用方式", "托管会话"]) {
      expect(html).toContain(label);
    }
    for (const label of ["API key required", "Agent browser access", "Hosted sessions"]) {
      expect(html).not.toContain(label);
    }
    // Brand names stay as written.
    expect(html).toContain("Browserbase");
  });
});
