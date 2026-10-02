import { type OrchestrationThreadActivity } from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";
import { deriveWorkLogEntries } from "./session-logic";
import { makeActivity } from "./session-logic.test-support";

describe("deriveWorkLogEntries context window handling", () => {
  it("excludes context window updates from the work log", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        id: "context-1",
        turnId: "turn-1",
        kind: "context-window.updated",
        summary: "Context window updated",
        tone: "info",
      }),
      makeActivity({
        id: "tool-1",
        turnId: "turn-1",
        kind: "tool.completed",
        summary: "Ran command",
        tone: "tool",
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Ran command");
  });

  it("keeps context compaction activities as normal work log entries", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        id: "compaction-1",
        turnId: "turn-1",
        kind: "context-compaction",
        summary: "Context compacted",
        tone: "info",
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Context compacted");
  });
});

describe("deriveWorkLogEntries quiet-timeline guarantee", () => {
  it("N concurrent subagents produce exactly N lifecycle rows, zero attributed tool rows", () => {
    const activities: OrchestrationThreadActivity[] = [];

    for (let agent = 0; agent < 5; agent += 1) {
      const taskId = `task-${agent}`;

      // Progress ticks (several per agent) + attributed tool rows.
      for (let tick = 0; tick < 4; tick += 1) {
        activities.push(
          makeActivity({
            kind: "task.progress",
            summary: `agent ${agent} tick ${tick}`,
            tone: "info",
            payload: { taskId, summary: `working ${tick}`, role: "explorer" },
            turnId: "turn-batch",
            sequence: agent * 20 + tick,
          }),
        );
        activities.push(
          makeActivity({
            kind: "tool.completed",
            summary: "Read",
            payload: { itemType: "dynamic_tool_call", agentId: taskId },
            sequence: agent * 20 + 10 + tick,
          }),
        );
      }

      activities.push(
        makeActivity({
          kind: "task.completed",
          summary: "Task completed",
          tone: "info",
          payload: {
            taskId,
            status: "completed",
            summary: `agent ${agent} done`,
            role: "explorer",
          },
          turnId: "turn-batch",
          sequence: agent * 20 + 19,
        }),
      );
    }

    const entries = deriveWorkLogEntries(activities);
    // A1 CTA design: all direct spawns in one turn collapse into ONE
    // call-to-action row carrying the batch's agent ids.
    const spawnRows = entries.filter((entry) => entry.agentSpawn !== undefined);
    expect(spawnRows).toHaveLength(1);
    expect(spawnRows[0]!.agentSpawn!.agentTaskIds).toHaveLength(5);
    expect(spawnRows[0]!.agentSpawn!.workflowId).toBeNull();
    // No agent-attributed tool rows leak into the main log.
    expect(entries.some((entry) => entry.sourceActivityKind?.startsWith("tool."))).toBe(false);
  });

  it("a workflow run and its members collapse into one CTA row keyed to the coordinator", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        kind: "task.progress",
        summary: "coordinator",
        tone: "info",
        payload: { taskId: "wf-1", taskType: "local_workflow", workflowName: "math-check" },
        sequence: 1,
      }),
      makeActivity({
        kind: "task.progress",
        summary: "member",
        tone: "info",
        payload: { taskId: "wf-1:wf:0", status: "running", parentAgentId: "wf-1" },
        sequence: 2,
      }),
      makeActivity({
        kind: "task.completed",
        summary: "member done",
        tone: "info",
        payload: { taskId: "wf-1:wf:1", status: "completed", parentAgentId: "wf-1" },
        sequence: 3,
      }),
    ]);

    const spawnRows = entries.filter((entry) => entry.agentSpawn !== undefined);
    expect(spawnRows).toHaveLength(1);
    expect(spawnRows[0]!.agentSpawn!.workflowId).toBe("wf-1");
    expect(spawnRows[0]!.agentSpawn!.agentTaskIds).toEqual(
      expect.arrayContaining(["wf-1", "wf-1:wf:0", "wf-1:wf:1"]),
    );
  });

  it("keeps unattributed tool rows (over-hiding loses the only signal)", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        kind: "tool.completed",
        summary: "Bash",
        payload: { itemType: "command_execution", command: "ls" },
      }),
    ]);

    expect(entries).toHaveLength(1);
  });

  it("folds timelineBypass agent rows into one CTA (Codex children, workflow members)", () => {
    // Codex children carry their parent's spawn turn (spawnTurnId stamping),
    // which is what batches a fleet into one CTA.
    const entries = deriveWorkLogEntries([
      makeActivity({
        kind: "task.progress",
        summary: "child work",
        tone: "info",
        payload: { taskId: "child-1", timelineBypass: true },
        turnId: "turn-spawn",
      }),
      makeActivity({
        kind: "task.progress",
        summary: "child work again",
        tone: "info",
        payload: { taskId: "child-2", timelineBypass: true },
        turnId: "turn-spawn",
      }),
    ]);

    // Not suppressed outright (a Codex fleet's rows are ALL bypassed and
    // still need a CTA anchor) — but never more than the batch's single row.
    expect(entries).toHaveLength(1);
    expect(entries[0]!.agentSpawn?.agentTaskIds).toEqual(["child-1", "child-2"]);
  });

  it("timelineBypass non-agent rows (background shells) stay suppressed", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        kind: "task.progress",
        summary: "stall",
        tone: "info",
        payload: { taskId: "sh-1", taskType: "local_bash", timelineBypass: true },
      }),
    ]);

    expect(entries).toHaveLength(0);
  });

  it("drops task.updated and tool.progress from the work log (fold input only)", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        kind: "task.updated",
        summary: "Task running",
        tone: "info",
        payload: { taskId: "task-1", status: "running" },
      }),
      makeActivity({
        kind: "tool.progress",
        summary: "Read",
        tone: "info",
        payload: { taskId: "task-1", toolName: "Read" },
      }),
    ]);

    expect(entries).toHaveLength(0);
  });
});

describe("rerun workflows", () => {
  it("turn-less direct spawns do not collapse into one global batch", () => {
    // Rows that lost their turn id (defensive path) group per task, so two
    // unrelated turn-less spawns never merge into one immortal CTA.
    const entries = deriveWorkLogEntries([
      makeActivity({
        kind: "task.started",
        summary: "Task started",
        payload: { taskId: "loose-1", taskType: "local_agent", role: "a" },
        sequence: 1,
      }),
      makeActivity({
        kind: "task.started",
        summary: "Task started",
        payload: { taskId: "loose-2", taskType: "local_agent", role: "b" },
        sequence: 2,
      }),
    ]);

    const spawnRows = entries.filter((entry) => entry.agentSpawn !== undefined);
    expect(spawnRows).toHaveLength(2);
    expect(spawnRows.map((row) => row.agentSpawn!.agentTaskIds)).toEqual([
      ["loose-1"],
      ["loose-2"],
    ]);
  });

  it("each workflow run gets its own CTA row (distinct coordinator ids)", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        kind: "task.progress",
        summary: "run 1",
        tone: "info",
        payload: { taskId: "wf-run1", taskType: "local_workflow", workflowName: "math-check" },
        turnId: "turn-1",
        sequence: 1,
      }),
      makeActivity({
        kind: "task.completed",
        summary: "run 1 done",
        tone: "info",
        payload: { taskId: "wf-run1", status: "completed", taskType: "local_workflow" },
        turnId: "turn-1",
        sequence: 2,
      }),
      makeActivity({
        kind: "task.progress",
        summary: "run 2",
        tone: "info",
        payload: { taskId: "wf-run2", taskType: "local_workflow", workflowName: "math-check" },
        turnId: "turn-2",
        sequence: 3,
      }),
    ]);

    const spawnRows = entries.filter((entry) => entry.agentSpawn !== undefined);
    expect(spawnRows.map((row) => row.agentSpawn!.workflowId)).toEqual(["wf-run1", "wf-run2"]);
    expect(spawnRows.map((row) => row.turnId)).toEqual(["turn-1", "turn-2"]);
  });
});
