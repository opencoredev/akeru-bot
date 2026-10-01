import { type OrchestrationThreadActivity } from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";
import { deriveWorkLogEntries } from "./session-logic";
import { makeActivity } from "./session-logic.test-support";

describe("work log tool data", () => {
  it("preserves MCP server, tool, arguments, and results for expanded display", () => {
    const item = {
      type: "mcpToolCall",
      server: "akeru",
      tool: "preview_status",
      arguments: {},
      status: "completed",
      result: { content: [{ type: "text", text: "attached" }] },
    };

    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "mcp-tool-done",
        kind: "tool.completed",
        summary: "akeru · preview_status",
        payload: {
          itemType: "mcp_tool_call",
          title: "akeru · preview_status",
          data: { item },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.toolTitle).toBe("akeru · preview_status");
    expect(entry?.toolData).toEqual(item);
  });

  it("preserves plugin search results for inline recommendations", () => {
    const result = {
      kind: "plugin-search-results",
      query: "email",
      total: 1,
      sources: { directory: "available", composio: "available" },
      recommendations: [
        {
          id: "composio:gmail",
          source: "composio",
          name: "Gmail",
          description: "Read and send email.",
          action: "connect",
          logoUrl: "https://logos.composio.dev/api/gmail",
        },
      ],
    };

    const [entry] = deriveWorkLogEntries([
      makeActivity({
        id: "plugin-search-done",
        kind: "tool.completed",
        summary: "SearchPlugins",
        payload: {
          itemType: "dynamic_tool_call",
          title: "SearchPlugins",
          data: { result },
        },
      }),
    ]);

    expect(entry?.toolData).toEqual(result);
  });

  it("keeps MCP payloads while collapsing lifecycle updates", () => {
    const item = {
      type: "mcpToolCall",
      server: "akeru",
      tool: "preview_snapshot",
      arguments: { interactiveOnly: true },
      status: "completed",
    };

    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "mcp-tool-progress",
        kind: "tool.updated",
        summary: "akeru · preview_snapshot",
        payload: {
          itemType: "mcp_tool_call",
          toolCallId: "call-1",
          data: { item },
        },
      }),
      makeActivity({
        id: "mcp-tool-complete",
        kind: "tool.completed",
        summary: "akeru · preview_snapshot",
        payload: {
          itemType: "mcp_tool_call",
          toolCallId: "call-1",
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.toolData).toEqual(item);
    expect(entry?.toolCallId).toBe("call-1");
  });

  it("keeps compact Codex tool metadata used for icons and labels", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-with-metadata",
        kind: "tool.completed",
        summary: "bash",
        payload: {
          itemType: "command_execution",
          title: "bash",
          status: "completed",
          detail: '{ "dev": "vite dev --port 3000" } <exited with exit code 0>',
          data: {
            item: {
              command: ["bun", "run", "dev"],
              result: {
                content: '{ "dev": "vite dev --port 3000" } <exited with exit code 0>',
                exitCode: 0,
              },
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry).toMatchObject({
      command: "bun run dev",
      detail: '{ "dev": "vite dev --port 3000" }',
      itemType: "command_execution",
      toolTitle: "bash",
    });
  });

  it("drops duplicated tool detail when it only repeats the title", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "read-file-generic",
        kind: "tool.completed",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.toolTitle).toBe("Read File");
    expect(entry?.detail).toBeUndefined();
  });

  it("uses grep raw output summaries instead of repeating the generic tool label", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "grep-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "grep",
        payload: {
          itemType: "web_search",
          title: "grep",
          detail: "grep",
          data: {
            toolCallId: "tool-grep-1",
            kind: "search",
            rawInput: {},
          },
        },
      }),
      makeActivity({
        id: "grep-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "grep",
        payload: {
          itemType: "web_search",
          title: "grep",
          detail: "grep",
          data: {
            toolCallId: "tool-grep-1",
            kind: "search",
            rawOutput: {
              totalFiles: 19,
              truncated: false,
            },
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "grep-complete",
      toolTitle: "grep",
      detail: "19 files",
      itemType: "web_search",
    });
  });
});
