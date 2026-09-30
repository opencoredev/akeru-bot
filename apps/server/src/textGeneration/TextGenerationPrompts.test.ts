import { describe, expect, it } from "vite-plus/test";

import { buildBranchNamePrompt, buildThreadTitlePrompt } from "./TextGenerationPrompts.ts";
import { normalizeCliError, sanitizeThreadTitle } from "./TextGenerationUtils.ts";
import { TextGenerationError } from "@akeru/contracts";

describe("buildBranchNamePrompt", () => {
  it("includes the user message in the prompt", () => {
    const result = buildBranchNamePrompt({
      message: "Fix the login timeout bug",
    });

    expect(result.prompt).toContain("User message:");
    expect(result.prompt).toContain("Fix the login timeout bug");
    expect(result.prompt).not.toContain("Attachment metadata:");
  });

  it("includes attachment metadata when attachments are provided", () => {
    const result = buildBranchNamePrompt({
      message: "Fix the layout from screenshot",
      attachments: [
        {
          type: "image" as const,
          id: "att-123",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 12345,
        },
      ],
    });

    expect(result.prompt).toContain("Attachment metadata:");
    expect(result.prompt).toContain("screenshot.png");
    expect(result.prompt).toContain("image/png");
    expect(result.prompt).toContain("12345 bytes");
  });
});

describe("buildThreadTitlePrompt", () => {
  it("includes the user message in the prompt", () => {
    const result = buildThreadTitlePrompt({
      message: "Investigate reconnect regressions after session restore",
    });

    expect(result.prompt).toContain("User message:");
    expect(result.prompt).toContain("Investigate reconnect regressions after session restore");
    expect(result.prompt).not.toContain("Attachment metadata:");
    expect(result.prompt).toContain(
      "Generate a title that will help the user recognize this Akeru Bot thread weeks later.",
    );
    expect(result.prompt).toContain(
      "Title the subject and outcome. Discard incidental instructions.",
    );
    expect(result.prompt).toContain(
      "Name the product change, not the mock, plan, report, branch, or PR used to produce it.",
    );
    expect(result.prompt).not.toContain(
      "Title should summarize the user's request, not restate it verbatim.",
    );
  });

  it("includes attachment metadata when attachments are provided", () => {
    const result = buildThreadTitlePrompt({
      message: "Name this thread from the screenshot",
      attachments: [
        {
          type: "image" as const,
          id: "att-456",
          name: "thread.png",
          mimeType: "image/png",
          sizeBytes: 67890,
        },
      ],
    });

    expect(result.prompt).toContain("Attachment metadata:");
    expect(result.prompt).toContain("thread.png");
    expect(result.prompt).toContain("image/png");
    expect(result.prompt).toContain("67890 bytes");
  });

  it("regenerates from recent thread contents and identifies the previous title", () => {
    const result = buildThreadTitlePrompt({
      message: `USER:\nInvestigate reconnect regressions\n\nASSISTANT:\nThe remaining issue is stale session state`,
      previousTitle: "Investigate reconnect regressions",
    });

    expect(result.prompt).toContain(
      "Regenerate the title for an existing Akeru Bot thread so the user can recognize it weeks later.",
    );
    expect(result.prompt).toContain('The previous title was "Investigate reconnect regressions".');
    expect(result.prompt).toContain(
      "Read the USER messages first. Identify the latest explicit durable goal.",
    );
    expect(result.prompt).toContain(
      "Do not promote one assistant finding into the thread subject unless the user adopts it as a new goal.",
    );
    expect(result.prompt).toContain(
      'A subagent-monitoring review that finds a Codex roster bug remains "Review Subagent Monitoring Risks,"',
    );
    expect(result.prompt).toContain("Thread contents:");
    expect(result.prompt).toContain("The remaining issue is stale session state");
  });

  it("keeps the latest thread contents when regeneration context is truncated", () => {
    const result = buildThreadTitlePrompt({
      message: `${"old context ".repeat(1_000)}\n\nASSISTANT:\nCurrent thread state`,
      previousTitle: "Old title",
    });

    expect(result.prompt).toContain("[Earlier content truncated]");
    expect(result.prompt).toContain("Current thread state");
    expect(result.prompt).not.toContain("[truncated]");
  });

  it("does not truncate an already-marked regeneration context twice", () => {
    const retainedContext = "x".repeat(7_998);
    const result = buildThreadTitlePrompt({
      message: `[Earlier content truncated]\n\n${retainedContext}`,
      previousTitle: "Old title",
    });

    expect(result.prompt).toContain(
      `Thread contents:\n[Earlier content truncated]\n\n${retainedContext}`,
    );
    expect(result.prompt.match(/\[Earlier content truncated\]/g)).toHaveLength(1);
  });
});

describe("sanitizeThreadTitle", () => {
  it.each([
    '{"title": "Refresh ev-stg APP ASG instances"}',
    '{\n  "title": "Refresh ev-stg APP ASG instances"\n}',
  ])("unwraps a JSON title before normalizing: %s", (raw) => {
    expect(sanitizeThreadTitle(raw)).toBe("Refresh ev-stg APP ASG instances");
  });

  it.each([
    "Rolling ES Refresh ev-stg",
    "Fix {title} interpolation",
    '{"title": 42}',
    '{"subject": "Fix parsing"}',
    '{"title": "unfinished}',
  ])("preserves text that is not a JSON title: %s", (raw) => {
    expect(sanitizeThreadTitle(raw)).toBe(raw);
  });

  it("normalizes the extracted title", () => {
    expect(sanitizeThreadTitle('{"title": "  Fix   reconnect failures  "}')).toBe(
      "Fix reconnect failures",
    );
    expect(sanitizeThreadTitle('{"title": "  "}')).toBe("New chat");
    expect(
      sanitizeThreadTitle(
        '{"title": "Reconnect failures after restart because the session state does not recover"}',
      ),
    ).toBe("Reconnect failures after restart because the se...");
  });

  it("truncates long titles with the shared sidebar-safe limit", () => {
    expect(
      sanitizeThreadTitle(
        '  "Reconnect failures after restart because the session state does not recover"  ',
      ),
    ).toBe("Reconnect failures after restart because the se...");
  });
});

describe("normalizeCliError", () => {
  it("uses the CLI name from the first argument for codex", () => {
    const error = normalizeCliError(
      "codex",
      "generateBranchName",
      new Error("Command not found: codex"),
      "Something went wrong",
    );

    expect(error).toBeInstanceOf(TextGenerationError);
    expect(error.detail).toContain("Codex CLI");
    expect(error.detail).toContain("not available on PATH");
  });
});
