// @effect-diagnostics globalDate:off -- Routine labels format wall-clock run times with Intl for display.
import type {
  BotId,
  McpServer,
  Routine,
  RoutineApprovalPolicy,
  RoutineRun,
  RoutineRunStatus,
  RoutineSandbox,
  RoutineSchedule,
  RoutineSkillAssignment,
} from "@t3tools/contracts";

import { createTranslator, type MessageKey } from "./i18n/index.ts";

export type RoutineAdapterFrequency = RoutineSchedule["kind"];
export type RoutineAdapterApproval = RoutineApprovalPolicy;
export type RoutineAdapterSandbox = RoutineSandbox;
export type RoutineAdapterRunStatus = RoutineRunStatus;

export interface RoutineAdapterProject {
  readonly id: string;
  readonly name: string;
}

export interface RoutineAdapterSchedule {
  readonly frequency: RoutineAdapterFrequency;
  readonly time: string;
  readonly timezone: string;
  readonly weekday: number | null;
}

export interface RoutineAdapterRun {
  readonly id: string;
  readonly status: RoutineAdapterRunStatus;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly summary: string | null;
  readonly error: string | null;
  readonly usage: string | null;
}

/** A routine as clients render it: names resolved, runs attached newest first. */
export interface RoutineAdapterItem {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly projectId: string;
  readonly sandbox: RoutineAdapterSandbox;
  readonly schedule: RoutineAdapterSchedule;
  readonly approval: RoutineAdapterApproval;
  readonly skills: readonly string[];
  readonly connectors: readonly string[];
  readonly procedureApproved: boolean;
  readonly enabled: boolean;
  readonly paused: boolean;
  /** Akeru paused it after a blocked or failed run, not the user. */
  readonly pausedByAkeru: boolean;
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
  readonly latestRun: RoutineAdapterRun | null;
  readonly runHistory: readonly RoutineAdapterRun[];
}

export interface RoutineAdapterDraft {
  readonly name: string;
  readonly prompt: string;
  readonly projectId: string;
  readonly sandbox: RoutineAdapterSandbox;
  readonly schedule: RoutineAdapterSchedule;
  readonly approval: RoutineAdapterApproval;
  readonly skills: readonly string[];
  readonly connectors: readonly string[];
}

const WEEKDAY_IDS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

const WEEKDAY_LABELS: readonly MessageKey[] = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export function toRoutineSchedule(draft: RoutineAdapterDraft): RoutineSchedule {
  if (draft.schedule.frequency !== "weekly") {
    return { kind: draft.schedule.frequency, time: draft.schedule.time };
  }
  return {
    kind: "weekly",
    weekdays: [WEEKDAY_IDS[draft.schedule.weekday ?? 1]!],
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
        ? WEEKDAY_IDS.indexOf(routine.schedule.weekdays[0] ?? "monday")
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
    pausedByAkeru: routine.lifecycle === "blocked" || routine.lifecycle === "failed",
    nextRunAt: routine.nextRunAt,
    lastRunAt: routine.lastRunAt,
    latestRun: history[0] ?? null,
    runHistory: history,
  };
}

/** The slice of an environment snapshot a bot's routine list reads. */
export interface BotRoutineSource {
  readonly routines?: readonly Routine[] | undefined;
  readonly routineRuns?: readonly RoutineRun[] | undefined;
  readonly skillAssignments?: readonly RoutineSkillAssignment[] | undefined;
  readonly mcpServers?: readonly McpServer[] | undefined;
}

export type BotRoutinesView =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly routines: readonly RoutineAdapterItem[] };

/**
 * One bot's live routines. A snapshot without a routines list comes from an environment
 * that predates routines, which is different from a bot that has none.
 */
export function botRoutinesView(
  snapshot: BotRoutineSource | null | undefined,
  botId: BotId | string,
): BotRoutinesView {
  if (!snapshot) return { kind: "loading" };
  if (snapshot.routines === undefined) return { kind: "unavailable" };
  return {
    kind: "ready",
    routines: snapshot.routines
      .filter((routine) => routine.botId === botId && routine.lifecycle !== "deleted")
      .map((routine) =>
        toRoutinePanelItem(
          routine,
          snapshot.routineRuns ?? [],
          snapshot.skillAssignments ?? [],
          snapshot.mcpServers ?? [],
        ),
      ),
  };
}

/** The translator slice routine labels need. Helpers default to English outside React. */
export type RoutineTranslator = Pick<ReturnType<typeof createTranslator>, "t" | "formatDate">;

const englishTranslator: RoutineTranslator = createTranslator("en");

export function routineScheduleLabel(
  schedule: RoutineAdapterSchedule,
  i18n: RoutineTranslator = englishTranslator,
) {
  const frequency =
    schedule.frequency === "daily"
      ? i18n.t("Daily")
      : schedule.frequency === "weekdays"
        ? i18n.t("Weekdays")
        : i18n.t(WEEKDAY_LABELS[schedule.weekday ?? 1] ?? "Monday");
  return i18n.t("{frequency} at {time} ({timezone})", {
    frequency,
    time: schedule.time,
    timezone: schedule.timezone,
  });
}

export function boundedRunHistory(history: readonly RoutineAdapterRun[]) {
  return history.slice(0, 5);
}

/**
 * The lifecycle state a routine is actually in, as the card and detail both label it.
 * A routine that was never approved is a Draft; one that was turned off is Off, and
 * the two take different routes back on.
 */
export function routineStatus(routine: RoutineAdapterItem): {
  readonly label: MessageKey & ("Active" | "Paused" | "Off" | "Draft");
  readonly variant: "success" | "warning" | "secondary";
} {
  if (routine.paused) return { label: "Paused", variant: "warning" };
  if (routine.enabled) return { label: "Active", variant: "success" };
  if (routine.procedureApproved) return { label: "Off", variant: "secondary" };
  return { label: "Draft", variant: "secondary" };
}

/**
 * Why a routine is not running on schedule, or null when it is. A routine Akeru paused
 * points to the Bot inbox, where its cause is waiting.
 */
export function routineStateNote(routine: RoutineAdapterItem): (MessageKey & string) | null {
  if (routine.pausedByAkeru) return "Paused. Fix the cause in Bot inbox, then resume it.";
  if (routine.paused) return "Paused until you resume it.";
  if (routine.enabled) return null;
  return routine.procedureApproved
    ? "Off until you turn it back on."
    : "Draft. Approve its procedure to schedule it.";
}

/**
 * The one lifecycle control a routine offers: the reverse of the state it is in. A draft
 * offers none, because approving its procedure comes first.
 */
export function routineLifecycleAction(
  routine: RoutineAdapterItem,
): "resume" | "enable" | "pause" | null {
  if (routine.paused) return "resume";
  if (routine.enabled) return "pause";
  if (routine.procedureApproved) return "enable";
  return null;
}

const RUN_STATUS_TONE = {
  completed: { label: "Completed", variant: "success" },
  failed: { label: "Failed", variant: "error" },
  running: { label: "Running", variant: "info" },
  queued: { label: "Queued", variant: "secondary" },
  "waiting-for-approval": { label: "Needs approval", variant: "warning" },
  blocked: { label: "Blocked", variant: "warning" },
  canceled: { label: "Canceled", variant: "secondary" },
} as const satisfies Record<
  RoutineAdapterRunStatus,
  {
    readonly label: MessageKey;
    readonly variant: "success" | "error" | "info" | "secondary" | "warning";
  }
>;

/** How one run reads at a glance: its chip wording and its semantic tone. */
export function runStatusTone(status: RoutineAdapterRunStatus) {
  return RUN_STATUS_TONE[status];
}

/** The absolute wall-clock label a relative time is paired with. */
export function absoluteRunTime(value: string, i18n: RoutineTranslator = englishTranslator) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return i18n.formatDate(date, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** An absolute run time, or "Not scheduled" when there is none. */
export function routineDateLabel(value: string | null, i18n: RoutineTranslator) {
  if (!value) return i18n.t("Not scheduled");
  return absoluteRunTime(value, i18n);
}

/**
 * "in 3h" ahead of an instant, "3h ago" behind it. Routine times land on both sides
 * of now — the next run is future, every run in the history is past.
 */
export function relativeRunTime(
  value: string,
  nowMs: number = Date.now(),
  i18n: RoutineTranslator = englishTranslator,
) {
  const target = new Date(value).getTime();
  if (Number.isNaN(target)) return "";
  const diffMs = target - nowMs;
  const seconds = Math.floor(Math.abs(diffMs) / 1000);
  if (seconds < 60) return i18n.t("now");
  const minutes = Math.floor(seconds / 60);
  const span =
    minutes < 60
      ? i18n.t("{count}m", { count: minutes })
      : minutes < 1440
        ? i18n.t("{count}h", { count: Math.floor(minutes / 60) })
        : i18n.t("{count}d", { count: Math.floor(minutes / 1440) });
  return diffMs >= 0 ? i18n.t("in {span}", { span }) : i18n.t("{span} ago", { span });
}

/** The single line a run gets in the history: its error, else its summary, else its status. */
export function runSummaryLine(
  run: RoutineAdapterRun,
  i18n: RoutineTranslator = englishTranslator,
) {
  const detail = run.error ?? run.summary ?? "";
  const line = detail.split("\n").find((part) => part.trim().length > 0);
  return line?.trim() || i18n.t(runStatusTone(run.status).label);
}

export interface RoutineApprovalSummary {
  readonly name: string;
  readonly instructions: string | null;
  /** "Weekdays at 09:00", or null when the proposal has no time. */
  readonly schedule: string | null;
}

/**
 * What a bot's `akeru_create_routine` request proposes, read defensively from the raw
 * tool arguments so a malformed request still renders as a reviewable approval.
 */
export function routineApprovalSummary(
  args: unknown,
  t: RoutineTranslator["t"] = englishTranslator.t,
): RoutineApprovalSummary {
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : null;
  const schedule =
    record?.schedule && typeof record.schedule === "object"
      ? (record.schedule as Record<string, unknown>)
      : null;
  const time = typeof schedule?.time === "string" ? schedule.time : null;
  const weekdays = Array.isArray(schedule?.weekdays)
    ? schedule.weekdays.filter((day): day is string => typeof day === "string")
    : [];
  const kind =
    schedule?.kind === "weekdays"
      ? t("Weekdays")
      : schedule?.kind === "weekly"
        ? weekdays.length > 0
          ? weekdays
              .map((day) => {
                const index = WEEKDAY_IDS.indexOf(day as (typeof WEEKDAY_IDS)[number]);
                return index === -1 ? day : t(WEEKDAY_LABELS[index]!);
              })
              .join(", ")
          : t("Weekly")
        : t("Daily");
  const base = time ? t("{schedule} at {time}", { schedule: kind, time }) : null;
  return {
    name: typeof record?.name === "string" && record.name.trim() ? record.name : t("New routine"),
    instructions:
      typeof record?.instructions === "string" && record.instructions.trim()
        ? record.instructions
        : null,
    // The tool proposes no timezone; the server uses the chat's device timezone.
    schedule: base,
  };
}
