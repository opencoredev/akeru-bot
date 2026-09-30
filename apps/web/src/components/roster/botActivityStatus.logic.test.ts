import {
  EventId,
  MessageId,
  TurnId,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
} from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveBotActivity } from "./botActivityStatus.logic";

const TURN = TurnId.make("turn-1");
const STARTED_AT = "2026-09-27T10:00:00.000Z";
const runningTurn: OrchestrationLatestTurn = {
  turnId: TURN,
  state: "running",
  requestedAt: "2026-09-27T09:59:59.000Z",
  startedAt: STARTED_AT,
  completedAt: null,
  assistantMessageId: null as MessageId | null,
};

let nextId = 0;
function activity(
  kind: string,
  summary: string,
  payload: Record<string, unknown> = {},
  turnId: TurnId | null = TURN,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(`activity-${nextId++}`),
    createdAt: STARTED_AT,
    kind,
    summary,
    tone: "tool",
    payload,
    turnId,
  };
}

const started = (name: string, id: string, payload: Record<string, unknown> = {}) =>
  activity("tool.started", `${name} started`, {
    itemType: "dynamic_tool_call",
    toolCallId: id,
    ...payload,
  });
const completed = (name: string, id: string) =>
  activity("tool.completed", name, { itemType: "dynamic_tool_call", toolCallId: id });

describe("deriveBotActivity", () => {
  it("says the bot is working before its first step", () => {
    expect(deriveBotActivity([], runningTurn)).toEqual({ label: "Working" });
  });

  it("names the routine tool while it runs", () => {
    expect(
      deriveBotActivity([started("akeru_create_routine", "call-1")], runningTurn),
    ).toMatchObject({ label: "Adding a routine" });
  });

  it("returns to working after a tool finishes", () => {
    expect(
      deriveBotActivity(
        [started("akeru_list_routines", "call-1"), completed("akeru_list_routines", "call-1")],
        runningTurn,
      ),
    ).toMatchObject({ label: "Working" });
  });

  it("labels routine deletes by name even though the item type says file change", () => {
    expect(
      deriveBotActivity(
        [started("akeru_delete_routines", "call-1", { itemType: "file_change" })],
        runningTurn,
      ),
    ).toMatchObject({ label: "Removing routines" });
  });

  it("tells memory reads from memory saves", () => {
    const read = started("memory", "call-1", { data: { memoryOperationCount: 0 } });
    const save = started("memory", "call-2", { data: { memoryOperationCount: 1 } });
    expect(deriveBotActivity([read], runningTurn).label).toBe("Reading memory");
    expect(deriveBotActivity([save], runningTurn).label).toBe("Saving to memory");
  });

  it("falls back to the item type for provider tools it does not know", () => {
    expect(
      deriveBotActivity(
        [started("bash -lc ls", "call-1", { itemType: "command_execution" })],
        runningTurn,
      ).label,
    ).toBe("Running a command");
  });

  it("shows the newest open tool when calls overlap", () => {
    expect(
      deriveBotActivity(
        [started("Read", "call-1"), started("SearchPlugins", "call-2")],
        runningTurn,
      ),
    ).toMatchObject({ label: "Searching plugins" });
  });

  it("keeps saying working while the bot updates its task list", () => {
    expect(
      deriveBotActivity([started("task_write", "plan-1", { itemType: "file_change" })], runningTurn)
        .label,
    ).toBe("Working");
  });

  it("prefers an open approval over the tool waiting on it", () => {
    expect(
      deriveBotActivity(
        [
          started("Shell", "call-1"),
          activity("approval.requested", "Approval requested", {
            requestId: "call-1",
            requestKind: "command",
          }),
        ],
        runningTurn,
      ).label,
    ).toBe("Waiting for approval");
  });

  it("ignores activity from earlier turns", () => {
    expect(
      deriveBotActivity([started("Shell", "old")], {
        ...runningTurn,
        turnId: TurnId.make("turn-2"),
      }),
    ).toEqual({ label: "Working" });
  });

  it("does not claim progress before a turn is running", () => {
    expect(deriveBotActivity([], null)).toEqual({ label: "Starting" });
  });
});
