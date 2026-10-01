import { TurnId } from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  deriveActiveWorkStartedAt,
  deriveWorkLogEntries,
  isLatestTurnSettled,
} from "./session-logic";
import { makeActivity } from "./session-logic.test-support";

describe("isLatestTurnSettled", () => {
  const latestTurn = {
    turnId: TurnId.make("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("returns false while the same turn is still active in a running session", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        status: "running",
        activeTurnId: TurnId.make("turn-1"),
      }),
    ).toBe(false);
  });

  it("returns false while any turn is running to avoid stale latest-turn banners", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        status: "running",
        activeTurnId: TurnId.make("turn-2"),
      }),
    ).toBe(false);
  });

  it("returns true once the session is no longer running that turn", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        status: "ready",
        activeTurnId: null,
      }),
    ).toBe(true);
  });

  it("returns false when turn timestamps are incomplete", () => {
    expect(
      isLatestTurnSettled(
        {
          turnId: TurnId.make("turn-1"),
          startedAt: null,
          completedAt: "2026-02-27T21:10:06.000Z",
        },
        null,
      ),
    ).toBe(false);
  });
});

describe("deriveActiveWorkStartedAt", () => {
  const latestTurn = {
    turnId: TurnId.make("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("prefers the in-flight turn start when the latest turn is not settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          status: "running",
          activeTurnId: TurnId.make("turn-1"),
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:10:00.000Z");
  });

  it("uses the new send start while the session is running a different turn", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          status: "running",
          activeTurnId: TurnId.make("turn-2"),
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });

  it("falls back to the latest user message while a running turn is being acknowledged", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          status: "running",
          activeTurnId: TurnId.make("turn-2"),
        },
        null,
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });

  it("falls back to sendStartedAt once the latest turn is settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          status: "ready",
          activeTurnId: null,
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });

  it("uses sendStartedAt for a fresh send after the prior turn completed", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          turnId: TurnId.make("turn-1"),
          startedAt: "2026-02-27T21:10:00.000Z",
          completedAt: "2026-02-27T21:10:06.000Z",
        },
        null,
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });
});

describe("session activity performance", () => {
  it("reuses entries for unchanged activities", () => {
    const activities = ["status", "diff", "log"].map((command, index) =>
      makeActivity({
        id: `stable-tool-${index}`,
        kind: "tool.completed",
        sequence: index,
        payload: {
          itemType: "command_execution",
          data: { toolCallId: `stable-tool-${index}`, item: { command: ["git", command] } },
        },
      }),
    );

    const initialEntries = deriveWorkLogEntries(activities.slice(0, 2));
    const appendedEntries = deriveWorkLogEntries(activities);
    expect(appendedEntries[0]).toBe(initialEntries[0]);
    expect(appendedEntries[1]).toBe(initialEntries[1]);
  });

  it("updates 20,000 ordered tool activities within 100 ms", () => {
    const activities = Array.from({ length: 20_000 }, (_, index) =>
      makeActivity({
        id: `benchmark-tool-${index}`,
        createdAt: new Date(1_700_000_000_000 + index).toISOString(),
        kind: "tool.completed",
        summary: "Ran command",
        sequence: index,
        payload: {
          itemType: "command_execution",
          title: "Ran command",
          data: {
            toolCallId: `benchmark-tool-${index}`,
            item: { command: ["git", "status"] },
          },
        },
      }),
    );
    deriveWorkLogEntries(activities);
    const updatedActivities = [
      ...activities,
      makeActivity({
        id: "benchmark-tool-appended",
        createdAt: new Date(1_700_000_000_000 + activities.length).toISOString(),
        kind: "tool.completed",
        summary: "Ran command",
        sequence: activities.length,
        payload: {
          itemType: "command_execution",
          title: "Ran command",
          data: { toolCallId: "benchmark-tool-appended", item: { command: ["git", "diff"] } },
        },
      }),
    ];

    const startedAt = performance.now();
    expect(deriveWorkLogEntries(updatedActivities)).toHaveLength(20_001);
    expect(performance.now() - startedAt).toBeLessThan(100);
  });
});
