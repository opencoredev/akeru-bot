import { describe, expect, it } from "vite-plus/test";
import { findTaskTitleInActivities } from "./ProviderRuntimeIngestion.ts";

describe("findTaskTitleInActivities", () => {
  it("reads a title from a projection activity record that uses activityId instead of id", () => {
    expect(
      findTaskTitleInActivities(
        [
          {
            kind: "task.started",
            payload: { taskId: "task-1", title: "Typecheck mobile app" },
          },
        ],
        "task-1",
      ),
    ).toBe("Typecheck mobile app");
  });

  it("prefers the latest matching progress title and ignores other tasks", () => {
    expect(
      findTaskTitleInActivities(
        [
          {
            kind: "task.started",
            payload: { taskId: "task-1", title: "first name" },
          },
          {
            kind: "task.progress",
            payload: { taskId: "task-2", title: "other task" },
          },
          {
            kind: "task.progress",
            payload: { taskId: "task-1", title: "latest name" },
          },
        ],
        "task-1",
      ),
    ).toBe("latest name");
  });
});
