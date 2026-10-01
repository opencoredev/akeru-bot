import { type OrchestrationThreadActivity } from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";
import { deriveWorkLogEntries } from "./session-logic";
import { makeActivity } from "./session-logic.test-support";

describe("work log agent tasks", () => {
  it("omits task.started but shows task.progress and task.completed", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        summary: "default task started",
        tone: "info",
      }),
      makeActivity({
        id: "task-progress",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        summary: "Updating files",
        tone: "info",
      }),
      makeActivity({
        id: "task-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "task.completed",
        summary: "Task completed",
        tone: "info",
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries.map((entry) => entry.id)).toEqual(["task-progress", "task-complete"]);
  });

  it("uses payload summary as label for task entries when available", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-progress-with-summary",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        summary: "Reasoning update",
        tone: "info",
        payload: { summary: "Searching for API endpoints" },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries[0]?.label).toBe("Searching for API endpoints");
  });

  it("uses payload detail as label for task.completed and preserves error tone", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-completed-failed",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "task.completed",
        summary: "Task failed",
        tone: "error",
        payload: { detail: "Failed to deploy changes" },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries[0]?.label).toBe("Failed to deploy changes");
    expect(entries[0]?.tone).toBe("error");
  });
});
