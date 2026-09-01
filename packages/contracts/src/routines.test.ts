import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ClientRoutineCommand,
  InternalRoutineCommand,
  Routine,
  RoutineDraftedPayload,
  RoutineRun,
  RoutineSchedule,
} from "./routines.ts";

const now = "2026-08-31T09:00:00.000Z";

const definition = {
  botId: "bot-inbox",
  targetThreadId: "thread-inbox",
  job: "Morning inbox",
  procedure: "Check new mail and prepare a summary.",
  schedule: { kind: "weekdays", time: "09:00" },
  timezone: "America/New_York",
  skillAssignmentIds: ["skill-assignment-email"],
  connectorDependencies: ["builtin-gmail"],
  projectId: "project-inbox",
  sandbox: "local",
  approvalPolicy: "approval-required",
} as const;

const routine = {
  id: "routine-inbox",
  ...definition,
  procedureVersion: 2,
  approvalVersion: 2,
  enabled: true,
  lifecycle: "enabled",
  nextRunAt: "2026-09-01T13:00:00.000Z",
  lastRunAt: null,
  latestResult: null,
  latestFailure: null,
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
} as const;

describe("routine contracts", () => {
  it("decodes a provider-neutral routine and durable run", () => {
    expect(Schema.decodeUnknownSync(Routine)(routine)).toMatchObject({
      id: "routine-inbox",
      schedule: { kind: "weekdays", time: "09:00" },
      approvalVersion: 2,
    });

    expect(
      Schema.decodeUnknownSync(RoutineRun)({
        id: "run-inbox-1",
        routineId: routine.id,
        procedureVersion: 2,
        trigger: "missed",
        scheduledFor: "2026-09-01T13:00:00.000Z",
        status: "completed",
        result: { summary: "Prepared a summary of 4 messages." },
        failure: null,
        usageRef: "usage-inbox-1",
        threadRef: "thread-inbox-1",
        startedAt: "2026-09-01T13:01:00.000Z",
        completedAt: "2026-09-01T13:02:00.000Z",
        createdAt: "2026-09-01T13:01:00.000Z",
        updatedAt: "2026-09-01T13:02:00.000Z",
      }),
    ).toMatchObject({ id: "run-inbox-1", trigger: "missed", status: "completed" });
  });

  it("rejects invalid local times, timezones, and empty weekly schedules", () => {
    const decode = Schema.decodeUnknownSync(RoutineSchedule);
    expect(() => decode({ kind: "daily", time: "24:00" })).toThrow();
    expect(() => decode({ kind: "weekly", weekdays: [], time: "09:00" })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(Routine)({ ...routine, timezone: "Mars/Olympus" }),
    ).toThrow();
  });

  it("requires a material draft to clear approval and disable the schedule", () => {
    const decode = Schema.decodeUnknownSync(RoutineDraftedPayload);
    expect(
      decode({
        routine: { ...routine, approvalVersion: null, enabled: false, lifecycle: "draft" },
      }),
    ).toBeDefined();
    expect(() => decode({ routine })).toThrow();
  });

  it("keeps scheduled and recovery triggers out of client run commands", () => {
    const decode = Schema.decodeUnknownSync(ClientRoutineCommand);
    const command = {
      type: "routine.run",
      commandId: "command-run-1",
      routineId: routine.id,
      runId: "run-inbox-1",
      createdAt: now,
    };
    expect(decode({ ...command, trigger: "dry-run" })).toMatchObject({ trigger: "dry-run" });
    expect(() => decode({ ...command, trigger: "scheduled" })).toThrow();
  });

  it("keeps atomic approved creation internal", () => {
    const command = {
      type: "routine.create-approved",
      commandId: "command-create-approved-1",
      routineId: routine.id,
      ...definition,
      createdAt: now,
    };

    expect(Schema.decodeUnknownSync(InternalRoutineCommand)(command)).toMatchObject({
      type: "routine.create-approved",
      routineId: routine.id,
    });
    expect(() => Schema.decodeUnknownSync(ClientRoutineCommand)(command)).toThrow();
  });
});
