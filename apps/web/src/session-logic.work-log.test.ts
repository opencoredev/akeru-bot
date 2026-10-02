import { TurnId, type OrchestrationThreadActivity } from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";
import { deriveWorkLogEntries, workEntryDisplayIndicatesToolFailure } from "./session-logic";
import { makeActivity } from "./session-logic.test-support";

describe("workEntryDisplayIndicatesToolFailure", () => {
  const base = {
    id: "w1",
    createdAt: "2026-01-01T00:00:00.000Z",
    label: "Read",
  };

  it("is true for error tone", () => {
    expect(
      workEntryDisplayIndicatesToolFailure({
        ...base,
        tone: "error",
        detail: "nothing special",
      }),
    ).toBe(true);
  });

  it("is true when lifecycle says failed even if detail is empty", () => {
    expect(
      workEntryDisplayIndicatesToolFailure({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "failed",
      }),
    ).toBe(true);
  });

  it("detects file-not-found style tool output with completed lifecycle", () => {
    expect(
      workEntryDisplayIndicatesToolFailure({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "completed",
        detail: "File not found: C:\\foo\\nonexistent.ts",
      }),
    ).toBe(true);
  });

  it("detects glob no files and PowerShell command errors", () => {
    expect(
      workEntryDisplayIndicatesToolFailure({
        ...base,
        label: "Glob",
        tone: "tool",
        detail: "No files found",
      }),
    ).toBe(true);
    expect(
      workEntryDisplayIndicatesToolFailure({
        ...base,
        label: "Bash",
        tone: "tool",
        detail:
          "The term 'this_is_not_a_command' is not recognized as the name of a cmdlet, function, script file, or operable program.",
      }),
    ).toBe(true);
  });

  it("is false for successful completed tools", () => {
    expect(
      workEntryDisplayIndicatesToolFailure({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "completed",
        detail: "Found 3 matching files",
      }),
    ).toBe(false);
  });

  it("does not run heuristics on non-tool info rows", () => {
    expect(
      workEntryDisplayIndicatesToolFailure({
        ...base,
        label: "Context compacted",
        tone: "info",
        detail: "File not found in conversation",
      }),
    ).toBe(false);
  });
});

describe("work log lifecycle", () => {
  it("keeps silent-run state out of the work log", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "silent",
        kind: "turn.silent",
        summary: "No response from Codex",
        tone: "info",
        turnId: "turn-1",
      }),
      makeActivity({
        id: "cleared",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "turn.silent.cleared",
        summary: "Codex responded",
        tone: "info",
        turnId: "turn-1",
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        turnId: "turn-1",
      }),
    ];

    expect(deriveWorkLogEntries(activities).map((entry) => entry.id)).toEqual(["tool-complete"]);
  });

  it("omits tool started entries and keeps completed entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "tool-start",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Tool call",
        kind: "tool.started",
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-complete"]);
  });

  it("keeps tool entries from every turn and tags each with its turn id", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "turn-1-tool",
        turnId: "turn-1",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "turn-2-tool",
        turnId: "turn-2",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries.map((entry) => entry.id)).toEqual(["turn-1-tool", "turn-2-tool"]);
    expect(entries.map((entry) => entry.turnId)).toEqual([
      TurnId.make("turn-1"),
      TurnId.make("turn-2"),
    ]);
  });

  it("omits checkpoint captured info entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "checkpoint",
        createdAt: "2026-02-23T00:00:01.000Z",
        summary: "Checkpoint captured",
        tone: "info",
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Ran command",
        tone: "tool",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-complete"]);
  });

  it("omits ExitPlanMode lifecycle entries once the plan card is shown", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "exit-plan-updated",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          detail: 'ExitPlanMode: {"allowedPrompts":[{"tool":"Bash","prompt":"run tests"}]}',
        },
      }),
      makeActivity({
        id: "exit-plan-completed",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          detail: "ExitPlanMode: {}",
        },
      }),
      makeActivity({
        id: "real-work-log",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          detail: "Bash: bun test",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries.map((entry) => entry.id)).toEqual(["real-work-log"]);
  });

  it("orders work log by activity sequence when present", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "second",
        createdAt: "2026-02-23T00:00:03.000Z",
        sequence: 2,
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "first",
        createdAt: "2026-02-23T00:00:04.000Z",
        sequence: 1,
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries.map((entry) => entry.id)).toEqual(["first", "second"]);
  });

  it("extracts failed tool lifecycle status from item payloads", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-failed",
        kind: "tool.updated",
        summary: "Glob",
        tone: "tool",
        payload: {
          itemType: "mcp_tool_call",
          status: "failed",
          detail: "No files found",
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.toolLifecycleStatus).toBe("failed");
  });

  it("defaults tool.completed entries to completed lifecycle status", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-done",
        kind: "tool.completed",
        summary: "Glob",
        tone: "tool",
        payload: {
          itemType: "mcp_tool_call",
          detail: "Found 3 files",
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.toolLifecycleStatus).toBe("completed");
  });

  it("collapses interleaved lifecycle updates by tool call id", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-a-progress",
        createdAt: "2026-02-23T00:00:01.000Z",
        turnId: "turn-1",
        kind: "tool.updated",
        summary: "Tool A",
        payload: {
          itemType: "command_execution",
          toolCallId: "call-a",
          status: "inProgress",
          data: { command: "vp test run" },
        },
      }),
      makeActivity({
        id: "tool-b-progress",
        createdAt: "2026-02-23T00:00:02.000Z",
        turnId: "turn-1",
        kind: "tool.updated",
        summary: "Tool B",
        payload: {
          itemType: "command_execution",
          toolCallId: "call-b",
          status: "inProgress",
          data: { command: "vp lint" },
        },
      }),
      makeActivity({
        id: "tool-a-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        turnId: "turn-1",
        kind: "tool.completed",
        summary: "Tool A completed",
        payload: {
          itemType: "command_execution",
          toolCallId: "call-a",
          status: "completed",
        },
      }),
      makeActivity({
        id: "tool-b-complete",
        createdAt: "2026-02-23T00:00:04.000Z",
        turnId: "turn-1",
        kind: "tool.completed",
        summary: "Tool B completed",
        payload: {
          itemType: "command_execution",
          toolCallId: "call-b",
          status: "completed",
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities)).toMatchObject([
      {
        id: "tool-a-complete",
        command: "vp test run",
        toolCallId: "call-a",
        toolLifecycleStatus: "completed",
      },
      {
        id: "tool-b-complete",
        command: "vp lint",
        toolCallId: "call-b",
        toolLifecycleStatus: "completed",
      },
    ]);
  });

  it("does not merge reused tool call ids across turns", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "turn-1-tool",
        createdAt: "2026-02-23T00:00:01.000Z",
        turnId: "turn-1",
        kind: "tool.updated",
        summary: "Tool",
        payload: {
          itemType: "command_execution",
          toolCallId: "reused-call",
          status: "inProgress",
        },
      }),
      makeActivity({
        id: "turn-2-tool",
        createdAt: "2026-02-23T00:00:02.000Z",
        turnId: "turn-2",
        kind: "tool.completed",
        summary: "Tool completed",
        payload: {
          itemType: "command_execution",
          toolCallId: "reused-call",
          status: "completed",
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities)).toHaveLength(2);
  });

  it("uses completed read-file output previews and still collapses the same tool call", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "read-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
          data: {
            toolCallId: "tool-read-1",
            kind: "read",
            rawInput: {},
          },
        },
      }),
      makeActivity({
        id: "read-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
          data: {
            toolCallId: "tool-read-1",
            kind: "read",
            rawOutput: {
              content:
                'import * as Effect from "effect/Effect"\nimport * as Layer from "effect/Layer"\n',
            },
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "read-complete",
      toolTitle: "Read File",
      detail: 'import * as Effect from "effect/Effect"',
      itemType: "dynamic_tool_call",
    });
  });

  it("does not use command stdout as the detail when Cursor omits the command input", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "cursor-command-complete",
        createdAt: "2026-04-16T22:40:42.221Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          title: "Ran command",
          data: {
            toolCallId: "toolu_vrtx_01WypXgRM8PPygBtrVAZwzy5",
            kind: "execute",
            rawInput: {},
            rawOutput: {
              exitCode: 0,
              stdout: "total 960\napps\npackages\n",
              stderr: "",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry).toMatchObject({
      id: "cursor-command-complete",
      label: "Ran command",
      itemType: "command_execution",
      toolTitle: "Ran command",
    });
    expect(entry?.detail).toBeUndefined();
    expect(entry?.command).toBeUndefined();
  });

  it("collapses legacy completed tool rows that are missing tool metadata", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "legacy-read-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
          data: {
            toolCallId: "tool-read-legacy",
            kind: "read",
            rawInput: {},
          },
        },
      }),
      makeActivity({
        id: "legacy-read-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "legacy-read-complete",
      toolTitle: "Read File",
      itemType: "dynamic_tool_call",
    });
    expect(entries[0]?.detail).toBeUndefined();
  });

  it("collapses repeated lifecycle updates for the same tool call into one entry", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-update-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-update-2",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
          data: {
            item: {
              command: ["sed", "-n", "1,40p", "/tmp/app.ts"],
            },
          },
        },
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "tool-complete",
      createdAt: "2026-02-23T00:00:03.000Z",
      label: "Tool call completed",
      detail: 'Read: {"file_path":"/tmp/app.ts"}',
      command: "sed -n 1,40p /tmp/app.ts",
      itemType: "dynamic_tool_call",
      toolTitle: "Tool call",
    });
  });

  it("keeps separate tool entries when an identical call starts after the prior one completed", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-1-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-1-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-2-update",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-2-complete",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);

    expect(entries.map((entry) => entry.id)).toEqual(["tool-1-complete", "tool-2-complete"]);
  });

  it("collapses same-timestamp lifecycle rows even when completed sorts before updated by id", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "z-update-earlier",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "a-complete-same-timestamp",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "z-update-same-timestamp",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("a-complete-same-timestamp");
  });
});
