import {
  AKERU_CREATE_ROUTINE_TOOL_NAME,
  AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
  ApprovalRequestId,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { BotApprovalPrompt } from "./BotApprovalPrompt";

describe("BotApprovalPrompt", () => {
  it("renders a compact one-use command review with only valid decisions", () => {
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
    expect(markup).toContain("Run this command?");
    expect(markup).toContain("Runs once");
    expect(markup).toContain("Allow once");
    expect(markup).toContain("Never");
    expect(markup).not.toContain("Enable Auto Review");
    // Attaches to the top of the prompt box instead of floating in the transcript.
    expect(markup).not.toContain("max-w-xl");
    expect(markup).toContain("rounded-t-[1.65rem]");
    expect(markup).toContain("border-b-transparent");
    expect(markup).toContain("bg-primary");
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Could not answer approval.");
  });

  it("offers the three command decisions without extra status copy", () => {
    const markup = renderToStaticMarkup(
      <BotApprovalPrompt
        approval={{
          requestId: ApprovalRequestId.make("review-command-session"),
          requestKind: "command",
          createdAt: "2026-08-27T00:00:00.000Z",
          args: { command: "pwd" },
          options: [
            { decision: "acceptForSession", label: "Allow for session" },
            { decision: "accept", label: "Allow" },
            { decision: "decline", label: "Decline" },
          ],
        }}
        pendingCount={1}
        responding={false}
        error={null}
        onRespond={vi.fn()}
      />,
    );

    expect(markup).toContain("Enable Auto Review");
    expect(markup).toContain("Allow once");
    expect(markup).toContain("Never");
    expect(markup).not.toContain("Auto Review paused");
  });

  it.each([
    [AKERU_CREATE_ROUTINE_TOOL_NAME, "Review routine", "Create routine"],
    [AKERU_PRODUCT_FEEDBACK_TOOL_NAME, "Review product feedback", "Add to feedback draft"],
  ] as const)("keeps the specific review UI for %s", (toolName, heading, acceptLabel) => {
    const markup = renderToStaticMarkup(
      <BotApprovalPrompt
        approval={{
          requestId: ApprovalRequestId.make(`review-${toolName}`),
          requestKind: "command",
          toolName,
          appName: "Safari",
          createdAt: "2026-08-27T00:00:00.000Z",
          detail: heading,
          options: [
            { decision: "accept", label: acceptLabel },
            { decision: "decline", label: "Cancel" },
          ],
        }}
        pendingCount={1}
        responding={false}
        error={null}
        onRespond={vi.fn()}
      />,
    );

    expect(markup).toContain(heading);
    expect(markup).toContain("Safari");
    expect(markup).toContain(acceptLabel);
    expect(markup).not.toContain("Run this command?");
    expect(markup).not.toContain("Runs once");
  });
});
