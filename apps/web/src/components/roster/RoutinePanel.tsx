import { useEffect, useRef, useState } from "react";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Clock3Icon,
  PlusIcon,
} from "lucide-react";

import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export type RoutineAdapterFrequency = "daily" | "weekdays" | "weekly";
export type RoutineAdapterApproval =
  | "approval-required"
  | "auto-accept-edits"
  | "auto"
  | "full-access";
export type RoutineAdapterSandbox = "local" | "e2b" | "daytona" | "vercel-sandbox" | "upstash-box";
export type RoutineAdapterRunStatus =
  | "queued"
  | "waiting-for-approval"
  | "running"
  | "blocked"
  | "failed"
  | "completed"
  | "canceled";

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

export interface RoutinePanelProps {
  readonly botName: string;
  readonly status: "loading" | "ready" | "error" | "unavailable";
  readonly error?: string | null;
  readonly routines?: readonly RoutineAdapterItem[];
  readonly projectOptions?: readonly RoutineAdapterProject[];
  readonly skillOptions?: readonly string[];
  readonly connectorOptions?: readonly string[];
  readonly busyRoutineId?: string | null;
  readonly onCreate?: (draft: RoutineAdapterDraft) => void | Promise<void>;
  readonly onUpdate?: (routineId: string, draft: RoutineAdapterDraft) => void | Promise<void>;
  readonly onDryRun?: (routineId: string) => void;
  readonly onApproveProcedure?: (routineId: string) => void;
  readonly onRunNow?: (routineId: string) => void;
  readonly onSetEnabled?: (routineId: string, enabled: boolean) => void;
  readonly onSetPaused?: (routineId: string, paused: boolean) => void;
  readonly onDelete?: (routineId: string) => void | Promise<void>;
}

const EMPTY_ROUTINES: readonly RoutineAdapterItem[] = [];
const EMPTY_PROJECT_OPTIONS: readonly RoutineAdapterProject[] = [];

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function routineScheduleLabel(schedule: RoutineAdapterSchedule) {
  const frequency =
    schedule.frequency === "daily"
      ? "Daily"
      : schedule.frequency === "weekdays"
        ? "Weekdays"
        : WEEKDAYS[schedule.weekday ?? 1];
  return `${frequency} at ${schedule.time} (${schedule.timezone})`;
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
  readonly label: "Active" | "Paused" | "Off" | "Draft";
  readonly variant: "success" | "warning" | "secondary";
} {
  if (routine.paused) return { label: "Paused", variant: "warning" };
  if (routine.enabled) return { label: "Active", variant: "success" };
  if (routine.procedureApproved) return { label: "Off", variant: "secondary" };
  return { label: "Draft", variant: "secondary" };
}

const RUN_STATUS_PRESENTATION = {
  completed: { label: "Completed", variant: "success", dot: "bg-success" },
  failed: { label: "Failed", variant: "error", dot: "bg-destructive" },
  running: { label: "Running", variant: "info", dot: "bg-info" },
  queued: { label: "Queued", variant: "secondary", dot: "bg-muted-foreground" },
  "waiting-for-approval": { label: "Needs approval", variant: "warning", dot: "bg-warning" },
  blocked: { label: "Blocked", variant: "warning", dot: "bg-warning" },
  canceled: { label: "Canceled", variant: "secondary", dot: "bg-muted-foreground" },
} as const satisfies Record<
  RoutineAdapterRunStatus,
  { readonly label: string; readonly variant: string; readonly dot: string }
>;

/** How one run reads at a glance: its chip wording, its badge colour, and its history dot. */
export function runStatusPresentation(status: RoutineAdapterRunStatus) {
  return RUN_STATUS_PRESENTATION[status];
}

/** The absolute wall-clock label a relative time is paired with in its tooltip. */
export function absoluteRunTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function shortDate(value: string | null) {
  if (!value) return "Not scheduled";
  return absoluteRunTime(value);
}

/**
 * "in 3h" ahead of an instant, "3h ago" behind it. Routine times land on both sides
 * of now — the next run is future, every run in the history is past.
 */
export function relativeRunTime(value: string, nowMs: number = Date.now()) {
  const target = new Date(value).getTime();
  if (Number.isNaN(target)) return "";
  const diffMs = target - nowMs;
  const seconds = Math.floor(Math.abs(diffMs) / 1000);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  const span =
    minutes < 60
      ? `${minutes}m`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h`
        : `${Math.floor(minutes / 1440)}d`;
  return diffMs >= 0 ? `in ${span}` : `${span} ago`;
}

/** The single line a run gets in the history: its error, else its summary, else its status. */
export function runSummaryLine(run: RoutineAdapterRun) {
  const detail = run.error ?? run.summary ?? "";
  const line = detail.split("\n").find((part) => part.trim().length > 0);
  return line?.trim() || runStatusPresentation(run.status).label;
}

/**
 * The routine focus lands on once a deleted one is gone: the row that takes its
 * place in the list, else the row above it, else nothing — meaning the Routines
 * heading, because the list it would have returned to is now empty.
 */
export function focusTargetAfterRoutineDelete(
  routineIds: readonly string[],
  deletedId: string,
): string | null {
  const index = routineIds.indexOf(deletedId);
  if (index === -1) return routineIds[0] ?? null;
  return routineIds[index + 1] ?? routineIds[index - 1] ?? null;
}

function editDraft(routine: RoutineAdapterItem): RoutineAdapterDraft {
  return {
    name: routine.name,
    prompt: routine.prompt,
    projectId: routine.projectId,
    sandbox: routine.sandbox,
    schedule: routine.schedule,
    approval: routine.approval,
    skills: routine.skills,
    connectors: routine.connectors,
  };
}

function csv(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** The draft a brand-new routine starts from, in the viewer's own timezone. */
function blankDraft(projectOptions: readonly RoutineAdapterProject[]): RoutineAdapterDraft {
  return {
    name: "",
    prompt: "",
    projectId: projectOptions[0]?.id ?? "",
    sandbox: "local",
    schedule: {
      frequency: "daily",
      time: "09:00",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      weekday: null,
    },
    approval: "approval-required",
    skills: [],
    connectors: [],
  };
}

/**
 * Whether a routine form should close for this open change. A form mid-save holds
 * itself open: every dismissal — Escape, an outside press, the corner X, Cancel —
 * unmounts the guard on the submit already in flight, and a second submit mints a
 * second routine. Only the save that finishes closes it.
 */
export function routineFormClosesOnOpenChange(open: boolean, saving: boolean) {
  return !open && !saving;
}

/** The one routine form, opened either to create a routine or to edit the one you opened. */
function RoutineFormDialog({
  title,
  submitLabel,
  initialDraft,
  projectOptions,
  onClose,
  onSubmit,
}: {
  readonly title: string;
  readonly submitLabel: string;
  readonly initialDraft: RoutineAdapterDraft;
  readonly projectOptions: readonly RoutineAdapterProject[];
  readonly onClose: () => void;
  readonly onSubmit?: (draft: RoutineAdapterDraft) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState(() => initialDraft);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [saveError, setSaveError] = useState(false);
  const save = async () => {
    if (!onSubmit || savingRef.current) return;
    savingRef.current = true;
    setSaveError(false);
    setSaving(true);
    try {
      await onSubmit(draft);
      onClose();
    } catch {
      setSaveError(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      disablePointerDismissal={saving}
      onOpenChange={(open) => {
        if (routineFormClosesOnOpenChange(open, saving)) onClose();
      }}
    >
      <DialogPopup className="max-h-[min(42rem,90dvh)] max-w-lg flex-col overflow-hidden">
        <DialogHeader className="border-b px-6 py-5">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-4 px-6 py-5">
          <label className="block space-y-1.5 text-sm">
            <span>Name</span>
            <Input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span>Instructions</span>
            <Textarea
              value={draft.prompt}
              onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1.5 text-sm">
              <span>Schedule</span>
              <select
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={draft.schedule.frequency}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    schedule: {
                      ...draft.schedule,
                      frequency: event.target.value as RoutineAdapterFrequency,
                      weekday:
                        event.target.value === "weekly" ? (draft.schedule.weekday ?? 1) : null,
                    },
                  })
                }
              >
                <option value="daily">Daily</option>
                <option value="weekdays">Weekdays</option>
                <option value="weekly">Weekly</option>
              </select>
            </label>
            <label className="space-y-1.5 text-sm">
              <span>Time</span>
              <Input
                type="time"
                value={draft.schedule.time}
                onChange={(event) =>
                  setDraft({ ...draft, schedule: { ...draft.schedule, time: event.target.value } })
                }
              />
            </label>
          </div>
          {draft.schedule.frequency === "weekly" ? (
            <label className="block space-y-1.5 text-sm">
              <span>Day</span>
              <select
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={draft.schedule.weekday ?? 1}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    schedule: { ...draft.schedule, weekday: Number(event.target.value) },
                  })
                }
              >
                {WEEKDAYS.map((day, index) => (
                  <option key={day} value={index}>
                    {day}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="block space-y-1.5 text-sm">
            <span>Timezone</span>
            <Input
              value={draft.schedule.timezone}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  schedule: { ...draft.schedule, timezone: event.target.value },
                })
              }
            />
          </label>
          {projectOptions.length > 0 ? (
            <label className="block space-y-1.5 text-sm">
              <span>Project</span>
              <select
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={draft.projectId}
                onChange={(event) => setDraft({ ...draft, projectId: event.target.value })}
              >
                {projectOptions.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
          ) : !draft.projectId ? (
            <p className="text-xs text-muted-foreground">
              Add a project to this environment before creating a routine.
            </p>
          ) : null}
          <label className="block space-y-1.5 text-sm">
            <span>Skills</span>
            <Input
              value={draft.skills.join(", ")}
              onChange={(event) => setDraft({ ...draft, skills: csv(event.target.value) })}
            />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span>Connectors</span>
            <Input
              value={draft.connectors.join(", ")}
              onChange={(event) => setDraft({ ...draft, connectors: csv(event.target.value) })}
            />
          </label>
        </DialogPanel>
        {saveError ? (
          <p role="alert" className="px-6 text-sm text-destructive">
            Could not save routine. Try again.
          </p>
        ) : null}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={saving} />}>Cancel</DialogClose>
          <Button
            disabled={saving || !draft.name.trim() || !draft.prompt.trim() || !draft.projectId}
            onClick={() => void save()}
          >
            {saving ? "Saving" : submitLabel}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** A relative time that keeps its exact instant one hover away. */
function RunTime({ value, className }: { readonly value: string; readonly className?: string }) {
  const absolute = absoluteRunTime(value);
  if (!absolute) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={className}>{relativeRunTime(value)}</span>} />
      <TooltipPopup side="top">{absolute}</TooltipPopup>
    </Tooltip>
  );
}

/** The outcome of one run on a single line: status, when, and what it said. */
function RunLine({ run }: { readonly run: RoutineAdapterRun }) {
  const presentation = runStatusPresentation(run.status);
  return (
    <li className="flex items-baseline gap-2 text-xs">
      <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${presentation.dot}`} />
      <span className="sr-only">{presentation.label}</span>
      <RunTime value={run.startedAt} className="shrink-0 tabular-nums text-muted-foreground" />
      <span className={`min-w-0 flex-1 truncate ${run.error ? "text-destructive" : ""}`}>
        {runSummaryLine(run)}
      </span>
    </li>
  );
}

/** Past runs, newest first, kept out of the way behind their own count until asked for. */
function RunHistory({ runs }: { readonly runs: readonly RoutineAdapterRun[] }) {
  const [expanded, setExpanded] = useState(false);
  if (runs.length === 0) return null;

  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
        className="flex items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDownIcon
          aria-hidden
          className={`size-3 transition-transform ${expanded ? "" : "-rotate-90"}`}
        />
        {runs.length} {runs.length === 1 ? "run" : "runs"}
      </button>
      {expanded ? (
        <ul className="mt-1.5 space-y-1">
          {boundedRunHistory(runs).map((run) => (
            <RunLine key={run.id} run={run} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** When the routine next runs, or why it is not going to. */
function NextRunLine({ routine }: { readonly routine: RoutineAdapterItem }) {
  if (routine.paused) {
    return <p className="text-xs text-muted-foreground">Paused until you resume it.</p>;
  }
  if (!routine.enabled) {
    return (
      <p className="text-xs text-muted-foreground">
        {routine.procedureApproved
          ? "Off until you turn it back on."
          : "Draft. Approve its procedure to schedule it."}
      </p>
    );
  }
  if (!routine.nextRunAt) {
    return <p className="text-xs text-muted-foreground">No next run scheduled.</p>;
  }
  return (
    <p className="text-xs text-muted-foreground">
      Next run <RunTime value={routine.nextRunAt} className="text-foreground" />
    </p>
  );
}

/** One card in the list: what it is, when it runs next, how it last went, and the way back on. */
function RoutineCard({
  routine,
  busy,
  onOpen,
  onSetEnabled,
  onSetPaused,
}: {
  readonly routine: RoutineAdapterItem;
  readonly busy: boolean;
  readonly onOpen: () => void;
} & Pick<RoutinePanelProps, "onSetEnabled" | "onSetPaused">) {
  const status = routineStatus(routine);
  const latest = routine.latestRun;
  const dormant = routine.paused || !routine.enabled;
  // A routine only offers the switch it is actually missing: a paused one resumes,
  // a turned-off one turns on, and a never-approved one is approved from its detail.
  const reverse = routine.paused
    ? "resume"
    : !routine.enabled && routine.procedureApproved
      ? "enable"
      : null;

  return (
    <div
      data-routine-card={routine.id}
      className={`rounded-lg border px-2 py-2 ${dormant ? "border-border/60 bg-muted/20" : "border-border"}`}
    >
      <button
        type="button"
        aria-label={`Open ${routine.name}`}
        data-routine-row={routine.id}
        onClick={onOpen}
        className="flex w-full items-center gap-3 rounded-md px-1 py-1 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Clock3Icon
          aria-hidden
          className={`size-4 shrink-0 ${dormant ? "text-muted-foreground/60" : "text-muted-foreground"}`}
        />
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate text-sm font-medium ${dormant ? "text-muted-foreground" : ""}`}
          >
            {routine.name}
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {routineScheduleLabel(routine.schedule)}
          </span>
        </span>
        <Badge size="sm" variant={status.variant}>
          {status.label}
        </Badge>
        <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground/60" />
      </button>

      <div className="mt-1 space-y-1.5 pl-8">
        <NextRunLine routine={routine} />
        {latest ? (
          <div className="flex min-w-0 items-center gap-1.5">
            <Badge size="sm" variant={runStatusPresentation(latest.status).variant}>
              {runStatusPresentation(latest.status).label}
            </Badge>
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {runSummaryLine(latest)}
                  </span>
                }
              />
              <TooltipPopup side="top" className="max-w-80">
                {runSummaryLine(latest)}
              </TooltipPopup>
            </Tooltip>
          </div>
        ) : null}
        {routine.runHistory.length > 0 || reverse ? (
          <div className="flex items-center justify-between gap-2">
            <RunHistory runs={routine.runHistory} />
            {reverse === "resume" ? (
              <Button
                size="xs"
                variant="outline"
                disabled={busy || !onSetPaused}
                onClick={() => onSetPaused?.(routine.id, false)}
              >
                Resume
              </Button>
            ) : reverse === "enable" ? (
              <Button
                size="xs"
                variant="outline"
                disabled={busy || !onSetEnabled}
                onClick={() => onSetEnabled?.(routine.id, true)}
              >
                Enable
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The opened routine: its instruction, its cadence, its last result, then what you can do to it. */
export function RoutineDetail({
  routine,
  projectName,
  busy,
  onBack,
  onEdit,
  onDeleteRequest,
  ...actions
}: {
  readonly routine: RoutineAdapterItem;
  readonly projectName: string;
  readonly busy: boolean;
  readonly onBack: () => void;
  readonly onEdit: () => void;
  readonly onDeleteRequest: () => void;
} & Pick<
  RoutinePanelProps,
  "onApproveProcedure" | "onDryRun" | "onRunNow" | "onSetEnabled" | "onSetPaused"
>) {
  const status = routineStatus(routine);
  const latest = routine.latestRun;

  return (
    <div data-testid="routine-detail">
      <div className="flex items-center gap-2">
        <Button
          aria-label="Back to routines"
          data-routine-back=""
          size="icon-sm"
          variant="ghost"
          onClick={onBack}
        >
          <ChevronLeftIcon />
        </Button>
        <h4 className="min-w-0 flex-1 truncate text-sm font-medium">{routine.name}</h4>
        <Badge size="sm" variant={status.variant}>
          {status.label}
        </Badge>
      </div>

      <div className="mt-4 space-y-4">
        <section>
          <h5 className="text-xs font-medium text-muted-foreground">Instructions</h5>
          <p className="mt-1 whitespace-pre-wrap text-sm">{routine.prompt}</p>
        </section>

        <section>
          <h5 className="text-xs font-medium text-muted-foreground">When to run</h5>
          <p className="mt-1 flex items-center gap-1.5 text-sm">
            <Clock3Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            {routineScheduleLabel(routine.schedule)}
          </p>
          <dl className="mt-2 space-y-1 text-xs text-muted-foreground">
            <div className="flex gap-2">
              <dt>Next</dt>
              <dd className="text-foreground">{shortDate(routine.nextRunAt)}</dd>
            </div>
            <div className="flex gap-2">
              <dt>Last</dt>
              <dd className="text-foreground">{shortDate(routine.lastRunAt)}</dd>
            </div>
            <div className="flex gap-2">
              <dt>Workspace</dt>
              <dd className="min-w-0 truncate text-foreground">{projectName}</dd>
            </div>
          </dl>
        </section>

        {latest ? (
          <section>
            <h5 className="text-xs font-medium text-muted-foreground">Latest run</h5>
            <div className="mt-1 flex items-center gap-1.5">
              <Badge size="sm" variant={runStatusPresentation(latest.status).variant}>
                {runStatusPresentation(latest.status).label}
              </Badge>
              <RunTime value={latest.startedAt} className="text-xs text-muted-foreground" />
            </div>
            <p className={`mt-1 text-sm ${latest.error ? "text-destructive" : ""}`}>
              {runSummaryLine(latest)}
            </p>
            <div className="mt-2">
              <RunHistory runs={routine.runHistory} />
            </div>
          </section>
        ) : null}

        {!routine.procedureApproved ? (
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5">
            <p className="text-xs text-muted-foreground">
              This routine runs only once you approve its procedure.
            </p>
            <Button
              className="mt-2"
              size="xs"
              disabled={busy || !actions.onApproveProcedure}
              onClick={() => actions.onApproveProcedure?.(routine.id)}
            >
              Approve procedure
            </Button>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-1.5 border-t border-border pt-3">
          {routine.paused ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy || !actions.onSetPaused}
              onClick={() => actions.onSetPaused?.(routine.id, false)}
            >
              Resume
            </Button>
          ) : !routine.enabled && routine.procedureApproved ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy || !actions.onSetEnabled}
              onClick={() => actions.onSetEnabled?.(routine.id, true)}
            >
              Enable
            </Button>
          ) : routine.enabled ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy || !actions.onSetPaused}
              onClick={() => actions.onSetPaused?.(routine.id, true)}
            >
              Pause
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="outline"
            disabled={busy || !actions.onDryRun}
            onClick={() => actions.onDryRun?.(routine.id)}
          >
            Test
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={busy || !routine.procedureApproved || !actions.onRunNow}
            onClick={() => actions.onRunNow?.(routine.id)}
          >
            Run now
          </Button>
          <Button size="xs" variant="ghost" disabled={busy} onClick={onEdit}>
            Edit
          </Button>
          <Button size="xs" variant="destructive-outline" disabled={busy} onClick={onDeleteRequest}>
            Delete
          </Button>
        </div>
      </div>
    </div>
  );
}

export function RoutinePanel({
  botName,
  status,
  error,
  routines = EMPTY_ROUTINES,
  projectOptions = EMPTY_PROJECT_OPTIONS,
  busyRoutineId = null,
  onCreate,
  onUpdate,
  onDelete,
  ...actions
}: RoutinePanelProps) {
  const [creating, setCreating] = useState(false);
  const [editorRoutine, setEditorRoutine] = useState<RoutineAdapterItem | null>(null);
  const [deleteRoutine, setDeleteRoutine] = useState<RoutineAdapterItem | null>(null);
  const [deletingRoutineId, setDeletingRoutineId] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const deleteBusyRef = useRef(false);
  const [deleteError, setDeleteError] = useState(false);
  const [openRoutineId, setOpenRoutineId] = useState<string | null>(null);
  const openRoutine = routines.find((routine) => routine.id === openRoutineId) ?? null;

  // Opening a routine replaces the list under the pointer, so focus follows it
  // in and returns to the row you came from rather than to the top of the page.
  const listRef = useRef<HTMLDivElement | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const previousOpenId = useRef<string | null>(null);
  // Deleting is the one close that cannot go back where it came from: the row is
  // on its way out of the projection. The delete names its survivor here, and
  // holds it past the close so the confirm dialog does not restore focus over it.
  const deletedFocusTarget = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (deletingRoutineId === null || routines.some((routine) => routine.id === deletingRoutineId))
      return;
    setOpenRoutineId(null);
    setDeletingRoutineId(null);
  }, [deletingRoutineId, routines]);
  useEffect(() => {
    if (openRoutineId !== null && previousOpenId.current === null) {
      detailRef.current?.querySelector<HTMLElement>("[data-routine-back]")?.focus();
    } else if (openRoutineId === null && previousOpenId.current !== null) {
      const target =
        deletedFocusTarget.current === undefined
          ? previousOpenId.current
          : deletedFocusTarget.current;
      const rows =
        target === null
          ? []
          : (listRef.current?.querySelectorAll<HTMLElement>("[data-routine-row]") ?? []);
      let restored = false;
      for (const row of rows) {
        if (row.dataset.routineRow === target) {
          row.focus();
          restored = true;
          break;
        }
      }
      if (!restored) headingRef.current?.focus();
    }
    previousOpenId.current = openRoutineId;
  }, [openRoutineId]);

  return (
    <section className="px-4 py-4">
      {openRoutine === null ? (
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium" ref={headingRef} tabIndex={-1}>
            Routines
          </h3>
          {onCreate && status === "ready" && routines.length > 0 ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="New routine"
              onClick={() => setCreating(true)}
            >
              <PlusIcon aria-hidden />
            </Button>
          ) : null}
        </div>
      ) : null}
      {status === "loading" ? (
        <div
          className="flex min-h-20 items-center justify-center text-xs text-muted-foreground"
          aria-label="Loading routines"
        >
          Loading
        </div>
      ) : status === "error" ? (
        <p className="mt-2 text-xs text-destructive">{error || "Could not load routines."}</p>
      ) : status === "unavailable" ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Routines are not available for this environment.
        </p>
      ) : openRoutine !== null ? (
        <div ref={detailRef}>
          <RoutineDetail
            routine={openRoutine}
            projectName={
              projectOptions.find((project) => project.id === openRoutine.projectId)?.name ??
              openRoutine.projectId
            }
            busy={busyRoutineId === openRoutine.id}
            onBack={() => setOpenRoutineId(null)}
            onEdit={() => setEditorRoutine(openRoutine)}
            onDeleteRequest={() => setDeleteRoutine(openRoutine)}
            {...(actions.onApproveProcedure
              ? { onApproveProcedure: actions.onApproveProcedure }
              : {})}
            {...(actions.onDryRun ? { onDryRun: actions.onDryRun } : {})}
            {...(actions.onRunNow ? { onRunNow: actions.onRunNow } : {})}
            {...(actions.onSetEnabled ? { onSetEnabled: actions.onSetEnabled } : {})}
            {...(actions.onSetPaused ? { onSetPaused: actions.onSetPaused } : {})}
          />
        </div>
      ) : routines.length === 0 ? (
        <div className="py-6 text-center">
          <p className="text-sm font-medium">No routines</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Routines are recurring tasks {botName} runs on a schedule.
          </p>
          {onCreate ? (
            <Button className="mt-3" size="sm" onClick={() => setCreating(true)}>
              <PlusIcon aria-hidden />
              New routine
            </Button>
          ) : null}
          <p className="mt-2 text-xs text-muted-foreground">
            Or ask {botName} in chat to set one up.
          </p>
        </div>
      ) : (
        <div className="mt-2 space-y-1.5" ref={listRef}>
          {routines.map((routine) => (
            <RoutineCard
              key={routine.id}
              routine={routine}
              busy={busyRoutineId === routine.id}
              onOpen={() => {
                deletedFocusTarget.current = undefined;
                setOpenRoutineId(routine.id);
              }}
              {...(actions.onSetEnabled ? { onSetEnabled: actions.onSetEnabled } : {})}
              {...(actions.onSetPaused ? { onSetPaused: actions.onSetPaused } : {})}
            />
          ))}
        </div>
      )}
      {creating && onCreate ? (
        <RoutineFormDialog
          title="New routine"
          submitLabel="Create routine"
          initialDraft={blankDraft(projectOptions)}
          projectOptions={projectOptions}
          onSubmit={onCreate}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {editorRoutine ? (
        <RoutineFormDialog
          title="Edit routine"
          submitLabel="Save changes"
          initialDraft={editDraft(editorRoutine)}
          projectOptions={projectOptions}
          {...(onUpdate ? { onSubmit: (draft) => onUpdate(editorRoutine.id, draft) } : {})}
          onClose={() => setEditorRoutine(null)}
        />
      ) : null}
      <AlertDialog
        open={deleteRoutine !== null}
        onOpenChange={(open) => !open && !deleteBusyRef.current && setDeleteRoutine(null)}
      >
        <AlertDialogPopup
          // Cancelling belongs back on the Delete control it came from. Deleting does
          // not: that control and its routine are both leaving, so the list effect
          // places focus on the survivor and this must not move it afterwards.
          finalFocus={() => deletedFocusTarget.current === undefined}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Delete routine "{deleteRoutine?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the schedule and its run history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={deleteBusy} />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={deleteBusy || !onDelete}
              onClick={() => {
                if (!deleteRoutine || !onDelete || deleteBusyRef.current) return;
                const id = deleteRoutine.id;
                deleteBusyRef.current = true;
                setDeleteBusy(true);
                setDeleteError(false);
                void Promise.resolve()
                  .then(() => onDelete(id))
                  .then(() => {
                    deletedFocusTarget.current = focusTargetAfterRoutineDelete(
                      routines.map((item) => item.id),
                      id,
                    );
                    setDeletingRoutineId(id);
                    setDeleteRoutine(null);
                  })
                  .catch(() => setDeleteError(true))
                  .finally(() => {
                    deleteBusyRef.current = false;
                    setDeleteBusy(false);
                  });
              }}
            >
              {deleteBusy ? "Deleting" : "Delete"}
            </Button>
          </AlertDialogFooter>
          {deleteError ? (
            <p role="alert" className="text-sm text-destructive">
              Could not delete routine. Try again.
            </p>
          ) : null}
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}
