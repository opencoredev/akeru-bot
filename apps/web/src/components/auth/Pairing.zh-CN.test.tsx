import { catalogRegistry } from "@akeru/client-runtime/i18n";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { LanguageProvider } from "../../i18n";
import { PairingPanel } from "./PairingPanel";
import { PairingTokenForm } from "./PairingRouteSurface";

const zhCNCatalog = await catalogRegistry["zh-CN"]!();
const environment = { name: "Leo's workstation", address: "ms-a2.tail.ts.net:3773" };

function renderInChinese(children: ReactNode) {
  return renderToStaticMarkup(
    <LanguageProvider testCatalog={{ locale: "zh-CN", catalog: zhCNCatalog }}>
      {children}
    </LanguageProvider>,
  );
}

describe("pairing in Simplified Chinese", () => {
  it("translates the ready panel", () => {
    const html = renderInChinese(
      <PairingPanel environment={environment} status={{ kind: "ready" }} />,
    );
    for (const text of [
      "配对此浏览器",
      "配对后，此浏览器可以",
      "在这台机器上运行终端和命令",
      "设置 &gt; 连接",
      "地址",
    ]) {
      expect(html).toContain(text);
    }
    expect(html).toContain("Leo&#x27;s workstation");
    expect(html).not.toContain("Pairing lets this browser");
  });

  it("translates the rejected link help and keeps the command untranslated", () => {
    const html = renderInChinese(
      <PairingPanel environment={environment} status={{ kind: "rejected" }} />,
    );
    expect(html).toContain("此链接已失效");
    expect(html).toContain("获取新链接");
    expect(html).toContain("在服务器上运行 <code");
    expect(html).toContain("npx akeru-bot pair");
    expect(html).not.toContain("Get a new link");
  });

  it("translates the paired state with the environment name", () => {
    const html = renderInChinese(
      <PairingPanel environment={environment} status={{ kind: "paired" }} />,
    );
    expect(html).toContain("已配对");
    expect(html).toContain("此浏览器现在可以使用 Leo&#x27;s workstation。");
  });

  it("translates the token form", () => {
    const html = renderInChinese(
      <PairingTokenForm
        credential=""
        fieldError={null}
        isSubmitting={false}
        onCredentialChange={() => undefined}
        onSubmit={() => undefined}
        showReload
        submitLabel="配对此浏览器"
        tokenLabel="配对令牌"
      />,
    );
    expect(html).toContain('placeholder="粘贴令牌"');
    expect(html).toContain("重新加载页面");
    expect(html).not.toContain("Reload page");
  });
});
