import { catalogRegistry, createTranslator } from "@t3tools/client-runtime/i18n";
import {
  AKERU_CREATE_ROUTINE_TOOL_NAME,
  ApprovalRequestId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { LanguageProvider } from "../../i18n";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { modelPickerEmptyMessage } from "./modelPickerEmptyState";
import { ReplyReference } from "./ReplyReference";

const zhCNCatalog = await catalogRegistry["zh-CN"]!();

function renderInChinese(children: ReactNode) {
  return renderToStaticMarkup(
    <LanguageProvider testCatalog={{ locale: "zh-CN", catalog: zhCNCatalog }}>
      {children}
    </LanguageProvider>,
  );
}

describe("chat surfaces in Simplified Chinese", () => {
  it("translates command and routine approval actions", () => {
    const command = renderInChinese(
      <ComposerPendingApprovalActions
        requestId={ApprovalRequestId.make("approval-command")}
        requestKind="command"
        isResponding={false}
        options={[
          { decision: "decline", label: "Decline" },
          { decision: "acceptAlways", label: "Always allow" },
          { decision: "accept", label: "Approve" },
        ]}
        onRespondToApproval={async () => undefined}
      />,
    );
    expect(command).toContain(zhCNCatalog["Never"]);
    expect(command).toContain(zhCNCatalog["Enable Auto Review"]);
    expect(command).toContain(zhCNCatalog["Allow once"]);
    expect(command).toContain(
      zhCNCatalog["Switch to Auto Review. Safe actions run, sensitive ones still ask."],
    );
    expect(command).not.toContain("Allow once");

    const routine = renderInChinese(
      <ComposerPendingApprovalActions
        requestId={ApprovalRequestId.make("approval-routine")}
        requestKind="command"
        toolName={AKERU_CREATE_ROUTINE_TOOL_NAME}
        isResponding={false}
        onRespondToApproval={async () => undefined}
      />,
    );
    expect(routine).toContain("不创建");
    expect(routine).toContain(zhCNCatalog["Create routine"]);
    expect(routine).not.toContain("Don&#x27;t create");
  });

  it("translates the routine proposal and command signals", () => {
    const routine = renderInChinese(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-weekly-routine"),
          requestKind: "command",
          toolName: AKERU_CREATE_ROUTINE_TOOL_NAME,
          createdAt: "2026-08-31T00:00:00.000Z",
          args: {
            name: "Friday review",
            instructions: "Review the week.",
            schedule: { kind: "weekly", weekdays: ["friday"], time: "14:00" },
            skillNames: ["Quotes"],
          },
        }}
        pendingCount={1}
      />,
    );
    expect(routine).toContain(`每${zhCNCatalog["Friday"]} 14:00`);
    expect(routine).toContain("它会做什么");
    expect(routine).toContain("使用 Quotes");
    expect(routine).not.toContain("What it does");

    const command = renderInChinese(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-risky"),
          requestKind: "command",
          createdAt: "2026-09-01T00:00:00.000Z",
          detail: "rm -rf dist",
          args: { command: "rm -rf dist" },
        }}
        pendingCount={1}
      />,
    );
    expect(command).toContain("删除文件");
    expect(command).not.toContain("Deletes files");
  });

  it("translates model picker empty states", () => {
    const { translate } = createTranslator("zh-CN", zhCNCatalog);
    const state = {
      searchQuery: "",
      selectedInstanceId: ProviderInstanceId.make("codex"),
      hasAnyModels: false,
      selectedInstanceModelsLoaded: true,
    };
    expect(modelPickerEmptyMessage({ ...state, searchQuery: "opus" }, translate)).toBe(
      "没有与“opus”匹配的模型。",
    );
    expect(
      modelPickerEmptyMessage({ ...state, selectedInstanceModelsLoaded: false }, translate),
    ).toBe("正在加载模型…");
    expect(modelPickerEmptyMessage(state, translate)).toBe(
      "没有可用的模型。请在设置中检查提供商连接。",
    );
  });

  it("translates the reply reference controls", () => {
    const html = renderInChinese(
      <ReplyReference label="Nova" text={"line one\nline two\nline three"} sourceMessageId="m1" />,
    );
    expect(html).toContain('aria-label="跳转到 Nova 的原始消息"');
    expect(html).toContain("显示完整消息");
    expect(html).not.toContain("Show full message");
  });
});
