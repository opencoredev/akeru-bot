import {
  EventId,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { activeThreadRuntimeWarning } from "./threadRuntimeWarning.logic";

const turnId = TurnId.make("turn-warning");
const timestamp = "2026-09-11T12:00:00.000Z";
const runningTurn: OrchestrationLatestTurn = {
  turnId,
  state: "running",
  requestedAt: timestamp,
  startedAt: timestamp,
  completedAt: null,
  assistantMessageId: null,
};
const warning: OrchestrationThreadActivity = {
  id: EventId.make("warning-current"),
  tone: "info",
  kind: "runtime.warning",
  summary: "Usage limit reached",
  payload: { message: "Claude is paused until the usage window resets." },
  turnId,
  createdAt: timestamp,
};

describe("activeThreadRuntimeWarning", () => {
  it("shows the latest warning for the running turn", () => {
    expect(activeThreadRuntimeWarning([warning], runningTurn)).toBe(
      "Claude is paused until the usage window resets.",
    );
  });

  it.each(["completed", "error"] as const)(
    "removes the active warning when the turn becomes %s",
    (state) => {
      expect(
        activeThreadRuntimeWarning([warning], {
          ...runningTurn,
          state,
          completedAt: timestamp,
        }),
      ).toBeNull();
    },
  );

  it("does not revive a warning from an earlier turn", () => {
    expect(
      activeThreadRuntimeWarning([warning], {
        ...runningTurn,
        turnId: TurnId.make("turn-recovered"),
      }),
    ).toBeNull();
  });
});
