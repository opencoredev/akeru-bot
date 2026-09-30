import {
  EventId,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
  TurnId,
} from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  activeThreadRuntimeWarning,
  latestBotThreadFailure,
  latestThreadRuntimeError,
} from "./threadRuntimeWarning.logic";

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

describe("latestThreadRuntimeError", () => {
  it("keeps a failed turn's provider error visible after the session recovers", () => {
    const failedTurn = { ...runningTurn, state: "error" as const, completedAt: timestamp };
    const activity = {
      ...warning,
      kind: "runtime.error",
      tone: "error" as const,
      payload: { message: "The usage limit has been reached" },
    };
    expect(latestThreadRuntimeError([activity], failedTurn)).toBe(
      "The usage limit has been reached",
    );
  });

  it("does not surface an old error for a running turn", () => {
    expect(latestThreadRuntimeError([warning], runningTurn)).toBeNull();
  });
});

describe("latestBotThreadFailure", () => {
  const laterTimestamp = "2026-09-11T12:05:00.000Z";
  const startFailed: OrchestrationThreadActivity = {
    ...warning,
    id: EventId.make("activity-start-failed"),
    kind: "provider.turn.start.failed",
    tone: "error",
    turnId: null,
    summary: "Provider turn start failed",
    payload: { detail: "Claude is not signed in.", unavailability: "missing-login" },
    createdAt: laterTimestamp,
  };

  it("explains a request the provider never started", () => {
    expect(
      latestBotThreadFailure({
        activities: [startFailed],
        latestTurn: null,
        session: { status: "error", lastError: "Claude is not signed in." },
        lastUserMessageAt: laterTimestamp,
      }),
    ).toEqual({ message: "Claude is not signed in.", unavailability: "missing-login" });
  });

  it("explains a newer request after an earlier turn completed", () => {
    const completedTurn = { ...runningTurn, state: "completed" as const, completedAt: timestamp };
    expect(
      latestBotThreadFailure({
        activities: [startFailed],
        latestTurn: completedTurn,
        session: { status: "error", lastError: "Claude is not signed in." },
        lastUserMessageAt: laterTimestamp,
      }),
    ).toEqual({ message: "Claude is not signed in.", unavailability: "missing-login" });
  });

  it("keeps a failed turn's category", () => {
    const failedTurn = {
      ...runningTurn,
      state: "error" as const,
      completedAt: timestamp,
      unavailability: "limit-reached" as const,
    };
    expect(
      latestBotThreadFailure({
        activities: [
          {
            ...warning,
            kind: "runtime.error",
            tone: "error",
            payload: { message: "The usage limit has been reached" },
          },
        ],
        latestTurn: failedTurn,
        session: null,
        lastUserMessageAt: timestamp,
      }),
    ).toEqual({
      message: "The usage limit has been reached",
      unavailability: "limit-reached",
    });
  });

  it("uses a newer start failure instead of an earlier failed turn", () => {
    const failedTurn = {
      ...runningTurn,
      state: "error" as const,
      completedAt: timestamp,
      unavailability: "limit-reached" as const,
    };
    expect(
      latestBotThreadFailure({
        activities: [startFailed],
        latestTurn: failedTurn,
        session: { status: "error", lastError: "Claude is not signed in." },
        lastUserMessageAt: laterTimestamp,
      }),
    ).toEqual({ message: "Claude is not signed in.", unavailability: "missing-login" });
  });

  it("stays quiet once the request has a reply", () => {
    const completedTurn = { ...runningTurn, state: "completed" as const, completedAt: timestamp };
    expect(
      latestBotThreadFailure({
        activities: [startFailed],
        latestTurn: completedTurn,
        session: { status: "ready", lastError: null },
        lastUserMessageAt: timestamp,
      }),
    ).toBeNull();
  });
});
