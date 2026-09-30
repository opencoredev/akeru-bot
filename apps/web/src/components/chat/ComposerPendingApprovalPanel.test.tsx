import { AKERU_CREATE_ROUTINE_TOOL_NAME, ApprovalRequestId } from "@akeru/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";

describe("ComposerPendingApprovalPanel", () => {
  it("shows the complete command without a duplicate disclosure", () => {
    const detail = `bun run release -- ${"x".repeat(500)}\nsecond line`;
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-1"),
          requestKind: "command",
          createdAt: "2026-07-18T00:00:00.000Z",
          detail,
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain('data-approval-detail="complete"');
    expect(markup).toContain('aria-label="Command"');
    expect(markup).toContain('role="group"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain(detail);
    expect(markup).toContain("max-h-28");
    expect(markup).toContain("overflow-auto");
    expect(markup).toContain("whitespace-pre-wrap");
    expect(markup).toContain("[scrollbar-width:thin]");
    expect(markup).toContain("[&amp;::-webkit-scrollbar]:h-1.5");
    expect(markup).toContain("break-words");
    expect(markup).not.toContain("line-clamp");
    expect(markup).toContain("min-w-0");
    expect(markup).not.toContain("Expand");
    expect(markup).not.toContain("Collapse");
    expect(markup).not.toContain("<details");
    expect(markup).not.toContain("Command approval requested");
  });

  it("drops the expander when a short command has nothing more to show", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-pwd"),
          requestKind: "command",
          createdAt: "2026-09-01T00:00:00.000Z",
          detail: "pwd",
          args: { command: "pwd" },
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain("pwd");
    expect(markup).toContain('data-approval-detail="complete"');
    expect(markup).not.toContain("Expand");
    expect(markup).not.toContain("Collapse");
    expect(markup).not.toContain("<details");
  });

  it("shows the folder, reason, and effects under the command", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-risky"),
          requestKind: "command",
          createdAt: "2026-09-01T00:00:00.000Z",
          detail: "cd apps/web && rm -rf dist",
          args: {
            command: "cd apps/web && rm -rf dist",
            cwd: "/tmp/work",
            justification: "Clear the stale build",
          },
        }}
        pendingCount={1}
      />,
    );

    expect(markup).not.toContain("Expand");
    expect(markup).toContain("Deletes files");
    expect(markup).toContain("/tmp/work");
    expect(markup).toContain("Clear the stale build");
  });

  it("falls back to the approval kind when the provider sends an empty detail", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-2"),
          requestKind: "file-read",
          createdAt: "2026-07-18T00:00:00.000Z",
          detail: "",
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain("File read approval");
  });

  it("shows the app name and message for an MCP access request", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-safari"),
          requestKind: "mcp-elicitation",
          createdAt: "2026-08-24T00:00:00.000Z",
          appName: "Safari",
          detail: "Allow ChatGPT to use Safari?",
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain('aria-label="App access approval"');
    expect(markup).toContain('aria-label="App access request"');
    expect(markup).toContain(">Safari<");
    expect(markup).toContain("Allow ChatGPT to use Safari?");
  });

  it("limits long app names so the complete approval message stays readable", () => {
    const appName = "A".repeat(200);
    const detail = "Allow ChatGPT to access the selected application?";
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-long-app-name"),
          requestKind: "mcp-elicitation",
          createdAt: "2026-08-24T00:00:00.000Z",
          appName,
          detail,
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain("max-w-32 shrink truncate");
    expect(markup).toContain(appName);
    expect(markup).toContain('data-approval-detail="complete"');
    expect(markup).toContain(detail);
  });

  it("shows a routine preview instead of a generic command approval", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-routine"),
          requestKind: "command",
          toolName: AKERU_CREATE_ROUTINE_TOOL_NAME,
          createdAt: "2026-08-31T00:00:00.000Z",
          detail: "Review routine",
          args: {
            name: "Daily brief",
            instructions: "Summarize the work in this chat.",
            schedule: { kind: "weekdays", time: "09:00" },
          },
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain("Review routine");
    expect(markup).toContain("Daily brief");
    expect(markup).toContain("Weekdays at 09:00");
    expect(markup).toContain("What it does");
    expect(markup).toContain("Summarize the work in this chat.");
    expect(markup).not.toContain("Command approval");
    expect(markup).not.toContain("Allow akeru_create_routine?");
  });

  it("shows the exact weekday and timezone in a weekly routine preview", () => {
    const markup = renderToStaticMarkup(
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
            timezone: "America/New_York",
          },
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain("Every Friday at 14:00");
    expect(markup).toContain("America/New_York");
  });

  it("does not repeat schedule wording in a routine's task summary", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-daily-routine"),
          requestKind: "command",
          toolName: AKERU_CREATE_ROUTINE_TOOL_NAME,
          createdAt: "2026-09-27T00:00:00.000Z",
          args: {
            name: "Morning quote",
            instructions:
              "Every day at 8:00 AM America/New_York, send me one short positive quote.",
            schedule: { kind: "daily", time: "08:00" },
            timezone: "America/New_York",
          },
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain("Send me one short positive quote.");
    expect(markup).not.toContain("Every day at 8:00 AM America/New_York,");
  });

  it("does not invent a name or schedule when the draft args are missing", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-routine-empty"),
          requestKind: "command",
          toolName: AKERU_CREATE_ROUTINE_TOOL_NAME,
          createdAt: "2026-09-27T00:00:00.000Z",
          detail: "Review routine",
        }}
        pendingCount={1}
        hideLabel
      />,
    );

    expect(markup).toContain("The routine details did not come through.");
    expect(markup).not.toContain("New routine");
    expect(markup).not.toContain("Daily");
    expect(markup).not.toContain("Every day");
    // The prompt owns the heading, so the panel must not repeat it.
    expect(markup).not.toContain("Review routine");
  });

  it("omits a schedule it cannot read instead of defaulting to daily", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-routine-partial"),
          requestKind: "command",
          toolName: AKERU_CREATE_ROUTINE_TOOL_NAME,
          createdAt: "2026-09-27T00:00:00.000Z",
          args: {
            name: "Morning quote",
            instructions: "Send a random positive quote.",
            schedule: { kind: "hourly", time: "08:00" },
            skillNames: ["Quotes"],
          },
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain("Morning quote");
    expect(markup).toContain("Send a random positive quote.");
    expect(markup).toContain("Uses Quotes");
    expect(markup).not.toContain("08:00");
  });
});
