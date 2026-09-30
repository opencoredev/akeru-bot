import {
  EventId,
  type OrchestrationThreadActivity,
  THREAD_SILENT_RUN_ACTIVITY_KIND,
  THREAD_SILENT_RUN_CLEARED_ACTIVITY_KIND,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isSilentRunActivity, threadSilentRun } from "./silentRun.ts";

const activity = (input: {
  id: string;
  kind: string;
  createdAt: string;
  turnId?: string;
  payload?: unknown;
}): OrchestrationThreadActivity => ({
  id: EventId.make(input.id),
  tone: "info",
  kind: input.kind,
  summary: input.kind,
  payload: input.payload ?? {},
  turnId: TurnId.make(input.turnId ?? "turn-1"),
  createdAt: input.createdAt,
});

const silent = (id: string, createdAt: string, turnId = "turn-1") =>
  activity({
    id,
    kind: THREAD_SILENT_RUN_ACTIVITY_KIND,
    createdAt,
    turnId,
    payload: { provider: "kimi", lastActivityAt: "2026-09-25T10:00:00.000Z" },
  });
const cleared = (id: string, createdAt: string) =>
  activity({
    id,
    kind: THREAD_SILENT_RUN_CLEARED_ACTIVITY_KIND,
    createdAt,
    payload: { provider: "kimi" },
  });

describe("threadSilentRun", () => {
  it("reports a silent running turn with the provider name", () => {
    expect(threadSilentRun([silent("a", "2026-09-25T10:01:30.000Z")], "turn-1")).toEqual({
      provider: "kimi",
      providerName: "Kimi For Coding",
      lastActivityAt: "2026-09-25T10:00:00.000Z",
    });
  });

  it("clears once output resumes, including on a timestamp tie", () => {
    expect(
      threadSilentRun(
        [silent("a", "2026-09-25T10:01:30.000Z"), cleared("b", "2026-09-25T10:02:00.000Z")],
        "turn-1",
      ),
    ).toBeNull();
    expect(
      threadSilentRun(
        [cleared("b", "2026-09-25T10:01:30.000Z"), silent("a", "2026-09-25T10:01:30.000Z")],
        "turn-1",
      ),
    ).toBeNull();
  });

  it("reports a later silent window after a clear", () => {
    expect(
      threadSilentRun(
        [
          silent("a", "2026-09-25T10:01:30.000Z"),
          cleared("b", "2026-09-25T10:02:00.000Z"),
          silent("c", "2026-09-25T10:03:30.000Z"),
        ],
        "turn-1",
      ),
    ).not.toBeNull();
  });

  it("ignores other turns, no running turn, and malformed payloads", () => {
    const activities = [silent("a", "2026-09-25T10:01:30.000Z", "turn-old")];
    expect(threadSilentRun(activities, "turn-1")).toBeNull();
    expect(threadSilentRun(activities, null)).toBeNull();
    expect(
      threadSilentRun(
        [
          activity({
            id: "x",
            kind: THREAD_SILENT_RUN_ACTIVITY_KIND,
            createdAt: "2026-09-25T10:01:30.000Z",
          }),
        ],
        "turn-1",
      ),
    ).toBeNull();
  });

  it("identifies silent-run activities for work log filtering", () => {
    expect(isSilentRunActivity({ kind: THREAD_SILENT_RUN_ACTIVITY_KIND })).toBe(true);
    expect(isSilentRunActivity({ kind: THREAD_SILENT_RUN_CLEARED_ACTIVITY_KIND })).toBe(true);
    expect(isSilentRunActivity({ kind: "tool.started" })).toBe(false);
  });
});
