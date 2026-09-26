import { RoutineId, ThreadId, type Routine, type RoutineRun } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createTranslator } from "./i18n/index.ts";
import { zhCNCatalog } from "./i18n/zh-CN.ts";
import {
  botRoutinesView,
  routineApprovalSummary,
  routineLifecycleAction,
  routineStateNote,
  runStatusTone,
  toRoutinePanelItem,
} from "./routines.ts";

const routine = {
  id: RoutineId.make("routine-1"),
  botId: "bot-1",
  targetThreadId: ThreadId.make("thread-1"),
  projectId: "project-1",
  job: "Daily digest",
  procedure: "Summarize the workspace",
  procedureVersion: 2,
  approvalVersion: 2,
  schedule: { kind: "weekly", weekdays: ["friday"], time: "09:00" },
  timezone: "America/New_York",
  skillAssignmentIds: ["assignment-1", "assignment-missing"],
  connectorDependencies: ["mcp-1"],
  sandbox: "local",
  approvalPolicy: "auto",
  delegateToBotId: null,
  enabled: true,
  lifecycle: "enabled",
  nextRunAt: "2026-09-20T13:00:00.000Z",
  lastRunAt: null,
  latestResult: null,
  latestFailure: null,
  createdAt: "2026-09-19T08:00:00.000Z",
  updatedAt: "2026-09-19T08:05:00.000Z",
  deletedAt: null,
} as unknown as Routine;

const run = (id: string, createdAt: string, overrides: Partial<RoutineRun> = {}) =>
  ({
    id,
    routineId: routine.id,
    trigger: "manual",
    scheduledFor: null,
    procedureVersion: 2,
    status: "completed",
    threadRef: null,
    result: { summary: "Sent the digest" },
    failure: null,
    usageRef: null,
    startedAt: null,
    completedAt: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  }) as unknown as RoutineRun;

const snapshot = {
  routines: [
    routine,
    { ...routine, id: RoutineId.make("routine-deleted"), lifecycle: "deleted" },
    { ...routine, id: RoutineId.make("routine-other"), botId: "bot-2" },
  ] as unknown as Routine[],
  routineRuns: [
    run("run-old", "2026-09-19T09:00:00.000Z"),
    run("run-new", "2026-09-19T10:00:00.000Z", {
      status: "failed",
      failure: { kind: "provider", message: "Provider timed out" },
    } as unknown as Partial<RoutineRun>),
  ],
  skillAssignments: [{ id: "assignment-1", name: "research" }],
  mcpServers: [{ id: "mcp-1", name: "Gmail" }],
} as unknown as Parameters<typeof botRoutinesView>[0];

describe("toRoutinePanelItem", () => {
  it("resolves names and orders run history newest first", () => {
    const item = toRoutinePanelItem(routine, snapshot!.routineRuns!, [], []);
    expect(item.schedule).toEqual({
      frequency: "weekly",
      time: "09:00",
      timezone: "America/New_York",
      weekday: 5,
    });
    expect(item.runHistory.map((entry) => entry.id)).toEqual(["run-new", "run-old"]);
    expect(item.latestRun).toMatchObject({ id: "run-new", error: "Provider timed out" });
    expect(item.runHistory[1]?.startedAt).toBe("2026-09-19T09:00:00.000Z");
  });
});

describe("botRoutinesView", () => {
  it("waits for the snapshot before claiming anything", () => {
    expect(botRoutinesView(null, "bot-1")).toEqual({ kind: "loading" });
  });

  it("separates an environment without routines from a bot without routines", () => {
    expect(botRoutinesView({}, "bot-1")).toEqual({ kind: "unavailable" });
    expect(botRoutinesView({ routines: [] }, "bot-1")).toEqual({ kind: "ready", routines: [] });
  });

  it("keeps only the bot's live routines with their skills and connectors", () => {
    const view = botRoutinesView(snapshot, "bot-1");
    expect(view.kind).toBe("ready");
    if (view.kind !== "ready") return;
    expect(view.routines.map((item) => item.id)).toEqual(["routine-1"]);
    expect(view.routines[0]).toMatchObject({
      skills: ["research"],
      connectors: ["Gmail"],
      procedureApproved: true,
    });
  });
});

describe("routineLifecycleAction", () => {
  const item = toRoutinePanelItem(routine, [], [], []);

  it("offers only the reverse of the state a routine is in", () => {
    expect(routineLifecycleAction(item)).toBe("pause");
    expect(routineLifecycleAction({ ...item, paused: true })).toBe("resume");
    expect(routineLifecycleAction({ ...item, enabled: false })).toBe("enable");
  });

  it("offers nothing for a draft until its procedure is approved", () => {
    expect(routineLifecycleAction({ ...item, enabled: false, procedureApproved: false })).toBe(
      null,
    );
  });
});

describe("routineStateNote", () => {
  const item = toRoutinePanelItem(routine, [], [], []);

  it("says nothing while a routine runs on schedule", () => {
    expect(routineStateNote(item)).toBe(null);
  });

  it("tells a user-paused routine apart from one Akeru stopped", () => {
    expect(routineStateNote({ ...item, paused: true })).toBe("Paused until you resume it.");
    const blocked = toRoutinePanelItem(
      { ...routine, lifecycle: "blocked" } as unknown as Routine,
      [],
      [],
      [],
    );
    expect(blocked.pausedByAkeru).toBe(true);
    expect(routineStateNote(blocked)).toBe("Paused. Fix the cause in Bot inbox, then resume it.");
  });

  it("names the way back for a routine that is off or still a draft", () => {
    expect(routineStateNote({ ...item, enabled: false })).toBe("Off until you turn it back on.");
    expect(routineStateNote({ ...item, enabled: false, procedureApproved: false })).toBe(
      "Draft. Approve its procedure to schedule it.",
    );
  });
});

describe("runStatusTone", () => {
  it("names every run status", () => {
    expect(runStatusTone("waiting-for-approval")).toEqual({
      label: "Needs approval",
      variant: "warning",
    });
    expect(runStatusTone("failed").variant).toBe("error");
  });
});

describe("routineApprovalSummary", () => {
  it("summarizes a proposed weekly routine", () => {
    expect(
      routineApprovalSummary({
        name: "Friday review",
        instructions: "Review the week.",
        schedule: { kind: "weekly", weekdays: ["monday", "friday"], time: "14:00" },
      }),
    ).toEqual({
      name: "Friday review",
      instructions: "Review the week.",
      schedule: "Monday, Friday at 14:00",
    });
  });

  it("still renders a malformed proposal as a reviewable approval", () => {
    expect(routineApprovalSummary(null)).toEqual({
      name: "New routine",
      instructions: null,
      schedule: null,
    });
    expect(routineApprovalSummary({ schedule: { kind: "weekdays", time: "09:00" } })).toEqual({
      name: "New routine",
      instructions: null,
      schedule: "Weekdays at 09:00",
    });
  });

  it("shows the proposed timezone beside a wall-clock schedule", () => {
    expect(
      routineApprovalSummary({
        schedule: { kind: "weekdays", time: "09:00" },
        timezone: "America/New_York",
      }).schedule,
    ).toBe("Weekdays at 09:00 (America/New_York)");
    expect(
      routineApprovalSummary({
        schedule: { kind: "weekdays", time: "09:00" },
        timezone: { invalid: true },
      }).schedule,
    ).toBe("Weekdays at 09:00");
  });

  it("follows the interface language", () => {
    const { t } = createTranslator("zh-CN", zhCNCatalog);
    expect(
      routineApprovalSummary({ name: "Brief", schedule: { kind: "daily", time: "08:00" } }, t)
        .schedule,
    ).toBe(t("{schedule} at {time}", { schedule: t("Daily"), time: "08:00" }));
  });
});
