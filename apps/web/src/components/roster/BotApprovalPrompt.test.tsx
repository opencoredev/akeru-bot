import { ApprovalRequestId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { BotApprovalPrompt } from "./BotApprovalPrompt";

describe("BotApprovalPrompt", () => {
  it("renders a one-use warning and only the hub-provided decisions", () => {
    const markup = renderToStaticMarkup(
      <BotApprovalPrompt
        approval={{
          requestId: ApprovalRequestId.make("send-call"),
          requestKind: "command",
          createdAt: "2026-08-27T00:00:00.000Z",
          detail: "Allow gmail_send_message?",
          options: [
            { decision: "decline", label: "Decline" },
            { decision: "accept", label: "Allow" },
          ],
        }}
        pendingCount={1}
        responding
        error="Could not answer approval."
        onRespond={vi.fn()}
      />,
    );

    expect(markup).toContain('data-testid="bot-approval-prompt"');
    expect(markup).toContain("This approval applies only to this action.");
    expect(markup).toContain("It cannot undo completed work.");
    expect(markup).toContain(">Decline<");
    expect(markup).toContain(">Allow<");
    expect(markup).not.toContain("Always allow");
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Could not answer approval.");
  });
});
