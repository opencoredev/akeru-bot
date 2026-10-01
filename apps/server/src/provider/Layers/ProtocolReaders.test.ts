import { describe, expect, it } from "vite-plus/test";
import {
  extractAssistantTextBlocks,
  extractContentBlockText,
  extractTextContent,
  readClaudeResumeState,
  sdkMessageSubtype,
  sdkMessageType,
} from "./claude/ClaudeProtocolValues.ts";
import { normalizeClaudeActiveTokenUsage } from "./claude/ClaudeUsage.ts";
import {
  normalizeTaskUsage,
  normalizeClaudeTaskStatus,
  parseWorkflowProgress,
  readStringArray,
} from "./claude/ClaudeTasks.ts";
import { parseGrokResume } from "./grok/GrokProtocol.ts";
import { parseOpenCodeResume, sessionErrorMessage } from "./opencode/OpenCodeProtocol.ts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

describe("tolerant SDK field readers", () => {
  it("extracts text despite opaque properties and unsupported siblings", () => {
    expect(extractTextContent([{ text: "visible" }, { unsupported: undefined }])).toBe("visible");
    expect(extractTextContent({ content: [{ text: "nested", extra: () => undefined }] })).toBe(
      "nested",
    );
    expect(extractContentBlockText({ type: "text", text: "visible", citations: undefined })).toBe(
      "visible",
    );

    // Partial SDK fixture deliberately omits unused message metadata.
    // @ts-expect-error Malformed citations intentionally exercise the tolerant SDK reader.
    const message = {
      type: "assistant",
      message: { content: [{ type: "text", text: "visible", citations: undefined }] },
    } as SDKMessage;

    expect(extractAssistantTextBlocks(message)).toEqual(["visible"]);
  });

  it("reads resume identifiers independently of optional fields", () => {
    const sessionId = "00000000-0000-4000-8000-000000000001";
    expect(readClaudeResumeState({ sessionId, turnCount: undefined })).toEqual({
      resume: sessionId,
    });
    const cursor = { schemaVersion: 1, sessionId: "session-1", extra: undefined };
    expect(parseGrokResume(cursor)).toEqual({ sessionId: "session-1" });
    expect(parseOpenCodeResume(cursor)).toEqual({ sessionId: "session-1" });
  });

  it("normalizes usage even when optional iterations are undefined", () => {
    const usage = { input_tokens: 10, output_tokens: 2, iterations: undefined };
    expect(normalizeClaudeActiveTokenUsage(usage)).toMatchObject({
      usedTokens: 12,
      inputTokens: 10,
      outputTokens: 2,
    });
    expect(
      normalizeClaudeActiveTokenUsage({
        iterations: [undefined, { input_tokens: 10, output_tokens: 2, extra: undefined }],
      }),
    ).toMatchObject({ usedTokens: 12 });
    expect(normalizeTaskUsage({ total_tokens: 12, tool_uses: undefined })).toEqual({
      totalTokens: 12,
    });
  });

  it("reads discriminators and errors without validating unrelated fields", () => {
    expect(sdkMessageType({ type: "system", extra: undefined })).toBe("system");
    expect(sdkMessageSubtype({ subtype: "init", extra: undefined })).toBe("init");
    expect(sessionErrorMessage({ data: { message: "failure", extra: undefined } })).toBe("failure");
  });

  it("keeps usable array entries when siblings are unsupported", () => {
    expect(normalizeClaudeTaskStatus("completed")).toBe("completed");
    expect(normalizeClaudeTaskStatus(" completed ")).toBe("pending");
    expect(readStringArray(["visible", undefined, () => undefined])).toEqual(["visible"]);
    expect(
      parseWorkflowProgress([
        { type: "workflow_phase", index: 0, title: "working", agents: undefined },
        undefined,
      ]),
    ).toBeDefined();
  });
});
