import {
  AKERU_CREATE_ROUTINE_TOOL_NAME,
  AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
  ApprovalRequestId,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

describe("ComposerPendingApprovalActions", () => {
  it("states that the persistent approval lasts for this session", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={ApprovalRequestId.make("approval-1")}
        isResponding={false}
        onRespondToApproval={async () => undefined}
      />,
    );

    expect(markup).toContain(">Cancel<");
    expect(markup).toContain("Always allow this session");
    expect(markup).not.toContain(">Always allow<");
    expect(markup).toContain("h-7");
    expect(markup).toContain("sm:h-6");
    expect(markup).toContain("bg-primary");
    expect(markup).toContain("border-input");
  });

  it("shows only the approval choices advertised by an MCP server", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={ApprovalRequestId.make("approval-safari")}
        isResponding={false}
        options={[
          { decision: "decline", label: "Decline" },
          { decision: "acceptAlways", label: "Always allow Safari" },
          { decision: "accept", label: "Approve" },
        ]}
        onRespondToApproval={async () => undefined}
      />,
    );

    expect(markup).toContain("Always allow Safari");
    expect(markup).toContain(">Approve<");
    expect(markup).not.toContain("Always allow this session");
  });

  it("limits provider-supplied approval labels so narrow rows can wrap", () => {
    const label = "Allow ".repeat(40).trim();
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={ApprovalRequestId.make("approval-long-label")}
        isResponding={false}
        options={[{ decision: "acceptAlways", label }]}
        onRespondToApproval={async () => undefined}
      />,
    );

    expect(markup).toContain('class="max-w-40 truncate"');
    expect(markup).toContain(label);
  });

  it("does not invent persistent permission for a one-use command", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={ApprovalRequestId.make("approval-shell")}
        requestKind="command"
        isResponding={false}
        options={[
          { decision: "decline", label: "Decline" },
          { decision: "accept", label: "Allow" },
        ]}
        onRespondToApproval={async () => undefined}
      />,
    );

    expect(markup).not.toContain("Enable Auto Review");
    expect(markup).toContain("Allow once");
    expect(markup).toContain("Never");
    expect(markup).not.toContain(">Decline<");
  });

  it("uses the three clear choices when session approval is available", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={ApprovalRequestId.make("approval-shell-session")}
        requestKind="command"
        isResponding={false}
        options={[
          { decision: "acceptForSession", label: "Allow for session" },
          { decision: "accept", label: "Allow" },
          { decision: "decline", label: "Decline" },
        ]}
        onRespondToApproval={async () => undefined}
      />,
    );

    expect(markup).toContain("Enable Auto Review");
    expect(markup).toContain("Allow once");
    expect(markup).toContain("Never");
  });

  it("uses one create or cancel choice for a routine", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={ApprovalRequestId.make("approval-routine")}
        requestKind="command"
        toolName={AKERU_CREATE_ROUTINE_TOOL_NAME}
        isResponding={false}
        options={[
          { decision: "accept", label: "Create routine" },
          { decision: "decline", label: "Cancel" },
        ]}
        onRespondToApproval={async () => undefined}
      />,
    );

    expect(markup).toContain("Create routine");
    expect(markup).toContain(">Cancel<");
    expect(markup).not.toContain("Enable Auto Review");
    expect(markup).not.toContain("Allow once");
    expect(markup).not.toContain(">Never<");

    const fallbackMarkup = renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={ApprovalRequestId.make("approval-routine-fallback")}
        requestKind="command"
        toolName={AKERU_CREATE_ROUTINE_TOOL_NAME}
        isResponding={false}
        onRespondToApproval={async () => undefined}
      />,
    );
    expect(fallbackMarkup).toContain("Create routine");
    expect(fallbackMarkup).toContain(">Cancel<");
    expect(fallbackMarkup).not.toContain("Enable Auto Review");
  });

  it("keeps product feedback action labels", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={ApprovalRequestId.make("approval-feedback")}
        requestKind="command"
        toolName={AKERU_PRODUCT_FEEDBACK_TOOL_NAME}
        isResponding={false}
        options={[
          { decision: "accept", label: "Add to feedback draft" },
          { decision: "decline", label: "Cancel" },
        ]}
        onRespondToApproval={async () => undefined}
      />,
    );

    expect(markup).toContain("Add to feedback draft");
    expect(markup).toContain(">Cancel<");
    expect(markup).not.toContain("Allow once");
    expect(markup).not.toContain(">Never<");
  });
});
