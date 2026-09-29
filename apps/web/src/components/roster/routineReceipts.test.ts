import { RoutineId, ThreadId, type Routine, type RoutineRun } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveRoutineReceipts, mergeRoutineRunHistory } from "./routineReceipts";

const routine = {
  id: RoutineId.make("routine-1"),
  botId: "bot-1",
  targetThreadId: ThreadId.make("thread-1"),
  projectId: "project-1",
  job: "Daily digest",
  procedure: "Summarize the workspace",
  procedureVersion: 1,
  approvalVersion: 1,
  schedule: { kind: "daily", time: "09:00" },
  timezone: "America/New_York",
  skillAssignmentIds: [],
  connectorDependencies: [],
  sandbox: "local",
  approvalPolicy: "auto",
  enabled: true,
  lifecycle: "enabled",
  nextRunAt: null,
  lastRunAt: null,
  latestResult: null,
  latestFailure: null,
  createdAt: "2026-09-19T08:00:00.000Z",
  updatedAt: "2026-09-19T08:05:00.000Z",
  deletedAt: null,
} as unknown as Routine;

const run = {
  id: "run-1",
  routineId: routine.id,
  trigger: "scheduled",
  scheduledFor: "2026-09-19T09:00:00.000Z",
  procedureVersion: 1,
  status: "completed",
  threadRef: routine.targetThreadId,
  result: { summary: "2 files changed" },
  failure: null,
  usageRef: null,
  startedAt: "2026-09-19T09:00:00.000Z",
  completedAt: "2026-09-19T09:01:00.000Z",
  createdAt: "2026-09-19T09:00:00.000Z",
  updatedAt: "2026-09-19T09:01:00.000Z",
} as unknown as RoutineRun;

describe("deriveRoutineReceipts", () => {
  it("retains older persisted runs while applying current shell updates", () => {
    const history = Array.from({ length: 6 }, (_, index) => ({
      ...run,
      id: `run-${index}`,
    })) as RoutineRun[];
    const latest = { ...history[5]!, status: "failed" as const };
    const merged = mergeRoutineRunHistory(history, [latest]);
    expect(merged).toHaveLength(6);
    expect(merged[0]?.id).toBe("run-0");
    expect(merged[5]?.status).toBe("failed");
  });

  it("keeps creation and run notes for a deleted routine's compact receipt source", () => {
    const receiptSource = {
      id: routine.id,
      targetThreadId: routine.targetThreadId,
      job: routine.job,
      createdAt: routine.createdAt,
    };
    expect(deriveRoutineReceipts(routine.targetThreadId, [receiptSource], [run])).toEqual(
      deriveRoutineReceipts(routine.targetThreadId, [routine], [run]),
    );
  });

  it("derives durable creation, enablement, start, and completion rows", () => {
    expect(deriveRoutineReceipts(routine.targetThreadId, [routine], [run])).toEqual([
      {
        id: "routine-created:routine-1",
        createdAt: "2026-09-19T08:00:00.000Z",
        text: 'Routine "Daily digest" was created',
        tone: "info",
      },
      {
        id: "routine-run-started:run-1",
        createdAt: "2026-09-19T09:00:00.000Z",
        text: '"Daily digest" started a run',
        tone: "info",
      },
      {
        id: "routine-run-finished:run-1",
        createdAt: "2026-09-19T09:01:00.000Z",
        text: '"Daily digest" finished: 2 files changed',
        tone: "success",
      },
    ]);
  });

  it("shows a started row while a run is in flight", () => {
    const running = {
      ...run,
      id: "run-2",
      status: "running",
      result: null,
      completedAt: null,
      updatedAt: "2026-09-19T09:00:00.000Z",
    } as unknown as RoutineRun;
    const receipts = deriveRoutineReceipts(routine.targetThreadId, [routine], [running]);
    expect(receipts.map((receipt) => receipt.id)).toEqual([
      "routine-created:routine-1",
      "routine-run-started:run-2",
    ]);
    expect(receipts[1]?.text).toBe('"Daily digest" started a run');
  });

  it("reports a failed run with its failure message", () => {
    const failed = {
      ...run,
      id: "run-6",
      status: "failed",
      result: null,
      failure: { message: "The workspace is missing" },
      completedAt: "2026-09-19T09:02:00.000Z",
    } as unknown as RoutineRun;
    const receipts = deriveRoutineReceipts(routine.targetThreadId, [routine], [failed]);
    expect(receipts[2]).toMatchObject({
      text: '"Daily digest" failed: The workspace is missing',
      tone: "error",
    });
  });

  it("keeps queued and waiting runs out of chat and reports canceled runs neutrally", () => {
    const queued = {
      ...run,
      id: "run-3",
      status: "queued",
      result: null,
      startedAt: null,
      completedAt: null,
    } as unknown as RoutineRun;
    const waiting = {
      ...run,
      id: "run-4",
      status: "waiting-for-approval",
      result: null,
      startedAt: null,
      completedAt: null,
    } as unknown as RoutineRun;
    const canceled = {
      ...run,
      id: "run-5",
      status: "canceled",
      result: null,
      completedAt: "2026-09-19T09:02:00.000Z",
    } as unknown as RoutineRun;
    const receipts = deriveRoutineReceipts(
      routine.targetThreadId,
      [routine],
      [queued, waiting, canceled],
    );
    expect(receipts.map((receipt) => [receipt.id, receipt.tone])).toEqual([
      ["routine-created:routine-1", "info"],
      ["routine-run-started:run-5", "info"],
      ["routine-run-finished:run-5", "info"],
    ]);
    expect(receipts[2]?.text).toBe('"Daily digest" was canceled');
  });
});
