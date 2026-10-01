import { useRef, useState } from "react";
import {
  type RoutineAdapterBot,
  type RoutineAdapterDraft,
  type RoutineAdapterFrequency,
  type RoutineAdapterItem,
  type RoutineAdapterProject,
} from "@akeru/client-runtime/routines";
import type { MessageKey } from "@akeru/client-runtime/i18n";

import { useI18n } from "../../i18n";
import { Button } from "../ui/button";
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

const WEEKDAYS: readonly MessageKey[] = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export function editDraft(routine: RoutineAdapterItem): RoutineAdapterDraft {
  return {
    name: routine.name,
    prompt: routine.prompt,
    projectId: routine.projectId,
    sandbox: routine.sandbox,
    schedule: routine.schedule,
    approval: routine.approval,
    skills: routine.skills,
    connectors: routine.connectors,
    delegateToBotId: routine.delegateToBotId,
  };
}

/** Most environments have a single workspace, so the picker only appears when there is a choice. */
export function showsWorkspacePicker(options: readonly RoutineAdapterProject[]) {
  return options.length > 1;
}

function csv(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** The draft a brand-new routine starts from, in the viewer's own timezone. */
export function blankDraft(projectOptions: readonly RoutineAdapterProject[]): RoutineAdapterDraft {
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
    delegateToBotId: null,
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
export function RoutineFormDialog({
  title,
  submitLabel,
  initialDraft,
  botName,
  projectOptions,
  delegateOptions,
  onClose,
  onSubmit,
}: {
  readonly title: MessageKey;
  readonly submitLabel: MessageKey;
  readonly initialDraft: RoutineAdapterDraft;
  readonly botName: string;
  readonly projectOptions: readonly RoutineAdapterProject[];
  readonly delegateOptions: readonly RoutineAdapterBot[];
  readonly onClose: () => void;
  readonly onSubmit?: (draft: RoutineAdapterDraft) => void | Promise<void>;
}) {
  const { t } = useI18n();
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
          <DialogTitle>{t(title)}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-4 px-6 py-5">
          <label className="block space-y-1.5 text-sm">
            <span>{t("Name")}</span>
            <Input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span>{t("Instructions")}</span>
            <Textarea
              value={draft.prompt}
              onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1.5 text-sm">
              <span>{t("Schedule")}</span>
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
                <option value="daily">{t("Daily")}</option>
                <option value="weekdays">{t("Weekdays")}</option>
                <option value="weekly">{t("Weekly")}</option>
              </select>
            </label>
            <label className="space-y-1.5 text-sm">
              <span>{t("Time")}</span>
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
              <span>{t("Day")}</span>
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
                    {t(day)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="block space-y-1.5 text-sm">
            <span>{t("Timezone")}</span>
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
          {showsWorkspacePicker(projectOptions) ? (
            <label className="block space-y-1.5 text-sm">
              <span>{t("Workspace")}</span>
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
              {t("Add a project to this environment before creating a routine.")}
            </p>
          ) : null}
          {delegateOptions.length > 0 || draft.delegateToBotId !== null ? (
            <label className="block space-y-1.5 text-sm">
              <span>{t("Done by")}</span>
              <select
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={draft.delegateToBotId ?? ""}
                onChange={(event) =>
                  setDraft({ ...draft, delegateToBotId: event.target.value || null })
                }
              >
                <option value="">{botName}</option>
                {delegateOptions.map((bot) =>
                  bot.canTakeWork === false ? (
                    <option key={bot.id} value={bot.id} disabled>
                      {`${bot.name}, ${t("Cannot take handed-off work")}`}
                    </option>
                  ) : (
                    <option key={bot.id} value={bot.id}>
                      {bot.name}
                    </option>
                  ),
                )}
                {draft.delegateToBotId !== null &&
                !delegateOptions.some((bot) => bot.id === draft.delegateToBotId) ? (
                  <option value={draft.delegateToBotId}>{t("Unknown bot")}</option>
                ) : null}
              </select>
            </label>
          ) : null}
          <label className="block space-y-1.5 text-sm">
            <span>{t("Skills")}</span>
            <Input
              value={draft.skills.join(", ")}
              onChange={(event) => setDraft({ ...draft, skills: csv(event.target.value) })}
            />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span>{t("Connectors")}</span>
            <Input
              value={draft.connectors.join(", ")}
              onChange={(event) => setDraft({ ...draft, connectors: csv(event.target.value) })}
            />
          </label>
        </DialogPanel>
        {saveError ? (
          <p role="alert" className="px-6 text-sm text-destructive">
            {t("Could not save routine")}. {t("Try again")}
          </p>
        ) : null}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={saving} />}>
            {t("Cancel")}
          </DialogClose>
          <Button
            disabled={saving || !draft.name.trim() || !draft.prompt.trim() || !draft.projectId}
            onClick={() => void save()}
          >
            {saving ? t("Saving") : t(submitLabel)}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
