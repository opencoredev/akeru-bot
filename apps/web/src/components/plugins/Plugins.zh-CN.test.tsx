import { catalogRegistry, createTranslator } from "@t3tools/client-runtime/i18n";
import { McpServerId, type McpServer } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { loadDirectoryCatalog } from "../../../../../plugins";
import { LanguageProvider } from "../../i18n";
import { CustomMcpServers, PluginsCatalog } from "./PluginsCatalog";
import {
  EMPTY_MCP_SERVER_DRAFT,
  PluginsPageHeader,
  pluginRecoveryNotice,
  validateMcpServerDraft,
} from "./PluginsDialog";
import { buildPluginSections } from "./pluginPresentation";

const zhCNCatalog = await catalogRegistry["zh-CN"]!();
const catalog = loadDirectoryCatalog();
const noop = () => undefined;
const rawServer: McpServer = {
  id: McpServerId.make("raw-filesystem"),
  name: "Raw filesystem",
  transport: "stdio",
  command: "bunx",
  args: [],
  enabled: true,
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
};

function renderInChinese(children: ReactNode) {
  return renderToStaticMarkup(
    <LanguageProvider testCatalog={{ locale: "zh-CN", catalog: zhCNCatalog }}>
      {children}
    </LanguageProvider>,
  );
}

describe("plugins in Simplified Chinese", () => {
  it("translates catalog sections and actions but keeps plugin names", () => {
    const html = renderInChinese(
      <PluginsCatalog
        sections={buildPluginSections({ plugins: catalog, query: "", filter: "All" })}
        servers={[]}
        pendingServerId={null}
        onToggle={noop}
        onOpen={noop}
      />,
    );
    expect(html).toContain('aria-label="精选"');
    expect(html).toContain(`连接 ${catalog[0]!.title}`);
    expect(html).not.toContain('aria-label="Featured"');
  });

  it("translates the empty catalog", () => {
    const html = renderInChinese(
      <PluginsCatalog
        sections={[]}
        servers={[]}
        pendingServerId={null}
        onToggle={noop}
        onOpen={noop}
        nothingInstalled
      />,
    );
    expect(html).toContain("还没有连接插件");
  });

  it("translates custom MCP servers and the page header", () => {
    const html = renderInChinese(
      <>
        <PluginsPageHeader />
        <CustomMcpServers
          servers={[rawServer]}
          pendingServerId={null}
          onCreate={noop}
          onToggle={noop}
          onEdit={noop}
          onDelete={noop}
        />
      </>,
    );
    for (const text of [
      "插件",
      "自定义 MCP 服务器",
      "添加服务器",
      "删除 Raw filesystem",
      "停用 Raw filesystem",
    ]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain("Custom MCP servers");
  });

  it("translates dialog validation and notices", () => {
    const { translate } = createTranslator("zh-CN", zhCNCatalog);
    expect(validateMcpServerDraft(EMPTY_MCP_SERVER_DRAFT, translate)).toBe("名称为必填项。");
    expect(pluginRecoveryNotice("Firecrawl", ["Boom."], translate)).toMatchObject({
      title: "Firecrawl 已连接，但会话出现问题",
      description: "Boom. 请重启受影响的机器人会话后重试。",
    });
  });
});
