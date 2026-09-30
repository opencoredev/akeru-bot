import { catalogRegistry } from "@t3tools/client-runtime/i18n";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  usePreparedConnection: () => ({ _tag: "Loading" }),
}));
vi.mock("../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
}));
vi.mock("../localShellAccess", () => ({
  useLocalShellAccess: () => ({ isLocal: true, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectForChangeRequest: () => undefined,
  matchesLinkedPullRequestUrl: () => false,
  parseChangeRequestUrl: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import { LanguageProvider } from "../i18n";
import ChatMarkdown from "./ChatMarkdown";

const zhCNCatalog = await catalogRegistry["zh-CN"]!();

function renderInChinese(text: string) {
  return renderToStaticMarkup(
    <LanguageProvider testCatalog={{ locale: "zh-CN", catalog: zhCNCatalog }}>
      <ChatMarkdown cwd="/tmp/project" text={text} />
    </LanguageProvider>,
  );
}

describe("chat markdown controls in Simplified Chinese", () => {
  it("translates table controls", () => {
    const html = renderInChinese(["| Name | Value |", "| --- | --- |", "| a | 1 |"].join("\n"));
    expect(html).toContain("复制表格");
    expect(html).toMatch(/(展开|收起)表格单元格/);
    expect(html).not.toContain("Copy table");
    expect(html).not.toMatch(/(Expand|Collapse) table cells/);
  });

  it("translates code block controls and the language label", () => {
    const html = renderInChinese(["```ts", "const a = 1;", "```"].join("\n"));
    expect(html).toContain("复制代码");
    expect(html).toContain("代码块操作");
    expect(html).toMatch(/(开启|关闭)自动换行/);
    for (const label of ["Copy code", "Code block actions", "Wrap lines", "Disable line wrap"]) {
      expect(html).not.toContain(label);
    }
  });

  it("translates the settings link tooltip", () => {
    const html = renderInChinese("[Providers](grokbot://app/v1/settings?id=providers)");
    expect(html).toContain("打开“设置 &gt; 提供商”");
    expect(html).not.toContain("Open Settings");
  });
});
