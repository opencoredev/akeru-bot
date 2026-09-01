import { useState } from "react";

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
  readonly onDelete?: (routineId: string) => void;
}

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

function shortDate(value: string | null) {
  if (!value) return "Not scheduled";
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function runLabel(run: RoutineAdapterRun) {
  if (run.error) return run.error;
  if (run.summary) return run.summary;
  return run.status === "completed" ? "Completed" : run.status.replaceAll("-", " ");
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

function RoutineEditor({
  routine,
  projectOptions,
  onClose,
  onUpdate,
}: {
  readonly routine: RoutineAdapterItem;
  readonly projectOptions: readonly RoutineAdapterProject[];
  readonly onClose: () => void;
  readonly onUpdate?: RoutinePanelProps["onUpdate"];
}) {
  const [draft, setDraft] = useState(() => editDraft(routine));
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!onUpdate) return;
    setSaving(true);
    try {
      await onUpdate(routine.id, draft);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-h-[min(42rem,90dvh)] max-w-lg flex-col overflow-hidden">
        <DialogHeader className="border-b px-6 py-5">
          <DialogTitle>Edit routine</DialogTitle>
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
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button
            disabled={saving || !draft.name.trim() || !draft.prompt.trim()}
            onClick={() => void save()}
          >
            {saving ? "Saving" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function RoutineCard({
  routine,
  busy,
  onEdit,
  onDeleteRequest,
  ...actions
}: {
  readonly routine: RoutineAdapterItem;
  readonly busy: boolean;
  readonly onEdit: () => void;
  readonly onDeleteRequest: () => void;
} & Pick<
  RoutinePanelProps,
  "onApproveProcedure" | "onDryRun" | "onRunNow" | "onSetEnabled" | "onSetPaused"
>) {
  const status = routine.paused ? "Paused" : routine.enabled ? "Active" : "Draft";
  const latest = routine.latestRun;
  return (
    <article className="rounded-lg border border-border/80 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <h4 className="min-w-0 flex-1 truncate text-sm font-medium">{routine.name}</h4>
        <Badge
          size="sm"
          variant={routine.paused ? "warning" : routine.enabled ? "success" : "secondary"}
        >
          {status}
        </Badge>
      </div>
      <p className="mt-1 truncate text-xs text-muted-foreground">
        {routineScheduleLabel(routine.schedule)}
      </p>
      <div className="mt-2 flex items-center gap-2 text-xs">
        <span className="shrink-0 text-muted-foreground">Next {shortDate(routine.nextRunAt)}</span>
        {latest ? (
          <span
            className={
              latest.error
                ? "min-w-0 truncate text-destructive"
                : "min-w-0 truncate text-muted-foreground"
            }
          >
            {runLabel(latest)}
          </span>
        ) : null}
      </div>
      {!routine.procedureApproved ? (
        <Button
          className="mt-2"
          size="micro"
          disabled={busy || !actions.onApproveProcedure}
          onClick={() => actions.onApproveProcedure?.(routine.id)}
        >
          Approve procedure
        </Button>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-1">
        <Button
          size="micro"
          variant="outline"
          disabled={busy || !actions.onDryRun}
          onClick={() => actions.onDryRun?.(routine.id)}
        >
          Dry run
        </Button>
        <Button
          size="micro"
          variant="outline"
          disabled={busy || !routine.procedureApproved || !actions.onRunNow}
          onClick={() => actions.onRunNow?.(routine.id)}
        >
          Run now
        </Button>
        {routine.paused ? (
          <Button
            size="micro"
            variant="outline"
            disabled={busy || !actions.onSetPaused}
            onClick={() => actions.onSetPaused?.(routine.id, false)}
          >
            Resume
          </Button>
        ) : !routine.enabled && routine.procedureApproved ? (
          <Button
            size="micro"
            variant="outline"
            disabled={busy || !actions.onSetEnabled}
            onClick={() => actions.onSetEnabled?.(routine.id, true)}
          >
            Enable
          </Button>
        ) : routine.enabled ? (
          <Button
            size="micro"
            variant="outline"
            disabled={busy || !actions.onSetPaused}
            onClick={() => actions.onSetPaused?.(routine.id, true)}
          >
            Pause
          </Button>
        ) : null}
        <Button size="micro" variant="ghost" disabled={busy} onClick={onEdit}>
          Edit
        </Button>
        <Button size="micro" variant="ghost-muted" disabled={busy} onClick={onDeleteRequest}>
          Delete
        </Button>
      </div>
    </article>
  );
}

export function RoutinePanel({
  botName,
  status,
  error,
  routines = [],
  projectOptions = [],
  busyRoutineId = null,
  onUpdate,
  onDelete,
  ...actions
}: RoutinePanelProps) {
  const [editorRoutine, setEditorRoutine] = useState<RoutineAdapterItem | null>(null);
  const [deleteRoutine, setDeleteRoutine] = useState<RoutineAdapterItem | null>(null);

  return (
    <section className="border-t border-border px-3 py-3">
      <h3 className="text-sm font-medium">Routines</h3>
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
      ) : routines.length === 0 ? (
        <div className="py-5 text-center">
          <p className="text-sm font-medium">No routines</p>
          <p className="mt-1 text-xs text-muted-foreground">Ask {botName} to create one.</p>
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          {routines.map((routine) => (
            <RoutineCard
              key={routine.id}
              routine={routine}
              busy={busyRoutineId === routine.id}
              onEdit={() => setEditorRoutine(routine)}
              onDeleteRequest={() => setDeleteRoutine(routine)}
              {...(actions.onApproveProcedure
                ? { onApproveProcedure: actions.onApproveProcedure }
                : {})}
              {...(actions.onDryRun ? { onDryRun: actions.onDryRun } : {})}
              {...(actions.onRunNow ? { onRunNow: actions.onRunNow } : {})}
              {...(actions.onSetEnabled ? { onSetEnabled: actions.onSetEnabled } : {})}
              {...(actions.onSetPaused ? { onSetPaused: actions.onSetPaused } : {})}
            />
          ))}
        </div>
      )}
      {editorRoutine ? (
        <RoutineEditor
          routine={editorRoutine}
          projectOptions={projectOptions}
          onUpdate={onUpdate}
          onClose={() => setEditorRoutine(null)}
        />
      ) : null}
      <AlertDialog
        open={deleteRoutine !== null}
        onOpenChange={(open) => !open && setDeleteRoutine(null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete routine "{deleteRoutine?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the schedule and its run history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <AlertDialogClose
              render={<Button variant="destructive" />}
              onClick={() => {
                if (deleteRoutine) onDelete?.(deleteRoutine.id);
                setDeleteRoutine(null);
              }}
            >
              Delete
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}
