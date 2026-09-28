import { catalogRegistry } from "@t3tools/client-runtime/i18n";
import { BotId, EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { LanguageProvider } from "../../i18n";

vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  createPortal: (children: unknown) => children,
}));
// Dialogs and sheets mount their popups after hydration, so render them inline when open.
vi.mock("../ui/dialog", async (importOriginal) => {
  const Pass = ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>;
  return {
    ...(await importOriginal<typeof import("../ui/dialog")>()),
    Dialog: ({ open, children }: { readonly open: boolean; readonly children?: ReactNode }) =>
      open ? <div>{children}</div> : null,
    DialogDescription: Pass,
    DialogFooter: Pass,
    DialogHeader: Pass,
    DialogPanel: Pass,
    DialogPopup: Pass,
    DialogTitle: Pass,
  };
});
vi.mock("../ui/sheet", async (importOriginal) => {
  const Pass = ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>;
  return {
    ...(await importOriginal<typeof import("../ui/sheet")>()),
    Sheet: ({ open, children }: { readonly open: boolean; readonly children?: ReactNode }) =>
      open ? <div>{children}</div> : null,
    SheetDescription: Pass,
    SheetFooter: Pass,
    SheetHeader: Pass,
    SheetPanel: Pass,
    SheetPopup: Pass,
    SheetTitle: Pass,
  };
});
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { readonly children?: ReactNode }) => <a>{children}</a>,
}));

import { BotDetailsPanel } from "./BotDetailsPanel";
import { BotMemorySheet } from "./BotMemorySheet";
import { RosterPanelHeader } from "./BotRosterSidebar";
import { BotStepMeter } from "./BotStepMeter";
import { BotToolsSection } from "./BotToolsSection";
import { BotUsageSection } from "./BotUsageSection";
import { GroupDetailsPanel } from "./GroupDetailsPanel";
import { NewBotDialog } from "./NewBotDialog";
import { NewGroupDialog } from "./NewGroupDialog";
import type { Bot, Group } from "./types";

// The shipped catalog, loaded the same way the language selector loads it.
const zhCNCatalog = await catalogRegistry["zh-CN"]!();

function renderInChinese(children: ReactNode) {
  return renderToStaticMarkup(
    <LanguageProvider testCatalog={{ locale: "zh-CN", catalog: zhCNCatalog }}>
      {children}
    </LanguageProvider>,
  );
}

function makeBot(id: string, name: string): Bot {
  return {
    id,
    name,
    title: "Generalist",
    label: null,
    description: null,
    disabledMcpServerIds: [],
    avatar: { kind: "blob", shape: "circle", color: "#5B7FD4" },
    engine: null,
    sandbox: null,
    runtimeMode: "full-access",
    usageCap: null,
    voiceEnabled: false,
    groupId: null,
    pinned: false,
    archivedAt: null,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
}

const akeru = makeBot("bot-akeru", "Akeru");
const mori = makeBot("bot-mori", "Mori");

describe("roster in Simplified Chinese", () => {
  it("translates the bot details panel", () => {
    const markup = renderInChinese(<BotDetailsPanel bot={akeru} />);
    expect(markup).toContain("打开 Akeru 机器人侧边栏");
    expect(markup).toContain("收起 Akeru 机器人侧边栏");
    expect(markup).toContain("没有可用的提供商");
    expect(markup).not.toContain("No provider ready");
    expect(markup).not.toContain("Open bot settings");
  });

  it("translates the group details panel", () => {
    const group: Group = {
      id: "group-1",
      name: "Research",
      bossBotId: akeru.id,
      members: [
        { kind: "bot", botId: BotId.make(akeru.id), role: "boss" },
        { kind: "bot", botId: BotId.make(mori.id), role: "specialist" },
      ],
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    };
    const markup = renderInChinese(
      <GroupDetailsPanel
        environmentId={EnvironmentId.make("environment-1")}
        group={group}
        bots={[akeru, mori]}
        onDeleted={() => {}}
      />,
    );
    expect(markup).toContain("删除群组");
    expect(markup).not.toContain("Delete group");
    expect(markup).not.toContain("Collapse");
  });

  it("translates the step meter", () => {
    const markup = renderInChinese(
      <BotStepMeter
        meter={{
          engine: { provider: ProviderInstanceId.make("codex"), model: "gpt-5" },
          tokens: 1200,
          costUsd: null,
          hardStopReached: true,
        }}
      />,
    );
    expect(markup).toContain("codex/gpt-5");
    expect(markup).toContain("个令牌");
    expect(markup).toContain("强制停止");
    expect(markup).not.toContain("tokens");
    expect(markup).not.toContain("Hard stop");
  });

  it("translates the usage section", () => {
    const markup = renderInChinese(<BotUsageSection environmentId={null} botId="bot-akeru" />);
    expect(markup).not.toContain("Bot usage");
    expect(markup).not.toContain("No usage");
    expect(markup).not.toContain("Loading");
  });

  it("translates the tools section", () => {
    const empty = renderInChinese(
      <BotToolsSection
        servers={[]}
        accessStatuses={[]}
        disabledIds={[]}
        onDisabledIdsChange={() => {}}
        canDelegate={false}
      />,
    );
    expect(empty).toContain("工具");
    expect(empty).toContain("管理插件");
    expect(empty).toContain("还没有工具");
    expect(empty).toContain("此机器人的提供商无法移交工作。");
    expect(empty).not.toContain("Manage plugins");
    expect(empty).not.toContain("No tools yet");
    expect(empty).not.toContain("cannot hand off work");
  });

  it("translates the memory sheet empty state", () => {
    const markup = renderInChinese(
      <BotMemorySheet open onOpenChange={() => {}} threadRef={null} />,
    );
    expect(markup).toContain("记忆");
    expect(markup).toContain("还没有记忆");
    expect(markup).toContain("与这个机器人开始聊天");
    expect(markup).not.toContain("No memory yet");
    expect(markup).not.toContain("What this bot remembers");
  });

  it("translates the new bot dialog", () => {
    const markup = renderInChinese(
      <NewBotDialog open onOpenChange={() => {}} onCreate={() => {}} />,
    );
    expect(markup).toContain("新建机器人");
    expect(markup).toContain("为你的队友设定身份");
    expect(markup).toContain("你的机器人");
    expect(markup).toContain("预览");
    expect(markup).toContain("机器人名称");
    expect(markup).toContain("为你的机器人命名");
    expect(markup).toContain("外观");
    expect(markup).toContain("上传图片");
    expect(markup).toContain("取消");
    expect(markup).not.toContain("Your bot");
    expect(markup).not.toContain("Name your bot");
    expect(markup).not.toContain("Appearance");
  });

  it("translates the new group dialog", () => {
    const markup = renderInChinese(
      <NewGroupDialog open bots={[akeru]} onOpenChange={() => {}} onCreate={() => {}} />,
    );
    expect(markup).toContain("新建群组");
    expect(markup).toContain("选择此群组中的机器人");
    expect(markup).toContain("请至少选择两个机器人。");
    expect(markup).not.toContain("Choose the bots");
    expect(markup).not.toContain("Select at least two bots.");
  });

  it("translates the roster panel header", () => {
    const markup = renderInChinese(
      <RosterPanelHeader onNewBot={() => {}} onNewGroup={() => {}} onSearch={() => {}} />,
    );
    expect(markup).toContain('aria-label="搜索"');
    expect(markup).toContain('aria-label="新建"');
    expect(markup).not.toContain('aria-label="Search"');
    expect(markup).not.toContain('aria-label="Create"');
  });
});
