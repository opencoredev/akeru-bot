import { ApprovalRequestId } from "@akeru/contracts";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Pressable: ({ children }: { readonly children?: ReactNode }) =>
    createElement("button", null, children),
  View: "div",
}));

vi.mock("../../components/AppText", () => ({ AppText: "span" }));

vi.mock("../../lib/i18n", async () => {
  const { createTranslator } = await import("@akeru/client-runtime/i18n");
  const translator = createTranslator("en");

  return { useMobileI18n: () => ({ ...translator, t: translator.translate }) };
});

import { PendingApprovalCard } from "./PendingApprovalCard";

describe("PendingApprovalCard", () => {
  it("shows a Claude Code owner approval's exact command, reason, and two answers", () => {
    const command = "git push --force origin main && rm -rf build/";

    const reason =
      "This bot's permission policy asks you first because it can change things outside the bot's workspace.";

    const markup = renderToStaticMarkup(
      <PendingApprovalCard
        approval={{
          requestId: ApprovalRequestId.make("approval-claude-code"),
          requestKind: "command",
          createdAt: "2026-10-31T00:00:00.000Z",
          toolName: "Bash",
          detail: `${command}\n\n${reason}`,
          args: { command, reason },
          options: [
            { decision: "decline", label: "Decline" },
            { decision: "accept", label: "Approve" },
          ],
        }}
        respondingApprovalId={null}
        onRespond={async () => undefined}
      />,
    );

    expect(markup).toContain("git push --force origin main &amp;&amp; rm -rf build/");
    expect(markup).toContain("permission policy asks you first");
    expect(markup).toContain("Approve");
    expect(markup).toContain("Decline");
    expect(markup).not.toContain("Allow session");
  });
});
