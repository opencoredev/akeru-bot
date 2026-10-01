import { EventId, TurnId, type OrchestrationThreadActivity } from "@akeru/contracts";
import { expect, it } from "vite-plus/test";
import { dropSupersededToolUpdatedActivities } from "./ActivityRetention.ts";

function tool(
  id: string,
  kind: string,
  callId: string,
  turnId = "turn-1",
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "tool",
    kind,
    summary: "Tool",
    payload: { toolCallId: callId },
    turnId: TurnId.make(turnId),
    createdAt: "2026-08-01T10:00:00.000Z",
  };
}

it("keeps completions and later in-flight updates for reused identities", () => {
  const rows = [
    tool("first-update", "tool.updated", "call"),
    tool("first-completion", "tool.completed", "call"),
    tool("second-update", "tool.updated", "call"),
    tool("parallel-update", "tool.updated", "parallel"),
    tool("second-completion", "tool.completed", "call"),
    tool("third-update", "tool.updated", "call"),
    tool("different-turn", "tool.updated", "call", "turn-2"),
  ];

  expect(dropSupersededToolUpdatedActivities(rows).map((row) => row.id)).toEqual([
    "first-completion",
    "parallel-update",
    "second-completion",
    "third-update",
    "different-turn",
  ]);
});

it("collapses interleaved calls within their own turns", () => {
  const rows = [
    tool("a-update", "tool.updated", "a"),
    tool("b-update", "tool.updated", "b"),
    tool("a-completion", "tool.completed", "a"),
    tool("b-completion", "tool.completed", "b"),
    tool("next-turn", "tool.updated", "a", "turn-2"),
  ];

  expect(dropSupersededToolUpdatedActivities(rows)).toEqual(rows.slice(2));
});
