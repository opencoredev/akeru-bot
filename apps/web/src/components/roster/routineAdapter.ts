import type {
  McpServer,
  Routine,
  RoutineRun,
  RoutineSchedule,
  RoutineSkillAssignment,
} from "@t3tools/contracts";

import type {
  RoutineAdapterDraft,
  RoutineAdapterItem,
  RoutineAdapterRun,
  RoutineAdapterSchedule,
} from "./RoutinePanel";

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

export function toRoutineSchedule(draft: RoutineAdapterDraft): RoutineSchedule {
  if (draft.schedule.frequency !== "weekly") {
    return { kind: draft.schedule.frequency, time: draft.schedule.time };
  }
  return {
    kind: "weekly",
    weekdays: [WEEKDAYS[draft.schedule.weekday ?? 1]!],
    time: draft.schedule.time,
  };
}

function toAdapterSchedule(routine: Routine): RoutineAdapterSchedule {
  return {
    frequency: routine.schedule.kind,
    time: routine.schedule.time,
    timezone: routine.timezone,
    weekday:
      routine.schedule.kind === "weekly"
        ? WEEKDAYS.indexOf(routine.schedule.weekdays[0] ?? "monday")
        : null,
  };
}

function toAdapterRun(run: RoutineRun): RoutineAdapterRun {
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt ?? run.createdAt,
    finishedAt: run.completedAt,
    summary: run.result?.summary ?? null,
    error: run.failure?.message ?? null,
    usage: run.usageRef,
  };
}

export function toRoutinePanelItem(
  routine: Routine,
  runs: readonly RoutineRun[],
  assignments: readonly RoutineSkillAssignment[],
  mcpServers: readonly McpServer[],
): RoutineAdapterItem {
  const history = runs
    .filter((run) => run.routineId === routine.id)
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map(toAdapterRun);
  const assignmentNames = new Map(
    assignments.map((assignment) => [assignment.id, assignment.name]),
  );
  const connectorNames = new Map(mcpServers.map((server) => [server.id, server.name]));

  return {
    id: routine.id,
    name: routine.job,
    prompt: routine.procedure,
    projectId: routine.projectId,
    sandbox: routine.sandbox,
    schedule: toAdapterSchedule(routine),
    approval: routine.approvalPolicy,
    skills: routine.skillAssignmentIds.flatMap((id) => {
      const name = assignmentNames.get(id);
      return name ? [name] : [];
    }),
    connectors: routine.connectorDependencies.flatMap((id) => {
      const name = connectorNames.get(id);
      return name ? [name] : [];
    }),
    procedureApproved: routine.approvalVersion === routine.procedureVersion,
    enabled: routine.enabled,
    paused:
      routine.lifecycle === "paused" ||
      routine.lifecycle === "blocked" ||
      routine.lifecycle === "failed",
    nextRunAt: routine.nextRunAt,
    lastRunAt: routine.lastRunAt,
    latestRun: history[0] ?? null,
    runHistory: history,
  };
}
