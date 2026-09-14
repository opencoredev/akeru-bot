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
const warningPayload = { message: "Claude is paused until the usage window resets." };
const warning: OrchestrationThreadActivity = {
  id: EventId.make("warning-current"),
  tone: "info",
  kind: "runtime.warning",
  summary: "Usage limit reached",
  payload: warningPayload,
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

  it("clears a recovered warning while the turn remains running", () => {
    expect(
      activeThreadRuntimeWarning(
        [
          { ...warning, payload: { ...warningPayload, key: "claude.rate-limit:five_hour" } },
          {
            ...warning,
            id: EventId.make("warning-recovered"),
            summary: "Claude usage limit recovered. Processing resumed.",
            payload: {
              message: "Claude usage limit recovered. Processing resumed.",
              key: "claude.rate-limit:five_hour",
              resolved: true,
            },
          },
        ],
        runningTurn,
      ),
    ).toBeNull();
  });

  it("keeps another keyed warning visible after one warning recovers", () => {
    expect(
      activeThreadRuntimeWarning(
        [
          { ...warning, payload: { ...warningPayload, key: "claude.rate-limit:seven_day" } },
          {
            ...warning,
            id: EventId.make("warning-five-hour"),
            payload: { ...warningPayload, key: "claude.rate-limit:five_hour" },
          },
          {
            ...warning,
            id: EventId.make("warning-five-hour-recovered"),
            summary: "Claude usage limit recovered. Processing resumed.",
            payload: {
              message: "Claude usage limit recovered. Processing resumed.",
              key: "claude.rate-limit:five_hour",
              resolved: true,
            },
          },
        ],
        runningTurn,
      ),
    ).toBe("Claude is paused until the usage window resets.");
  });
});
