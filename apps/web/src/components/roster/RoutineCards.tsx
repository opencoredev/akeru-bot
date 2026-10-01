import { Match } from "effect";
import { ChevronLeftIcon, ChevronRightIcon, Clock3Icon } from "lucide-react";
import {
  routineDateLabel,
  routineScheduleLabel,
  routineStatus,
  runSummaryLine,
  type RoutineAdapterItem,
} from "@akeru/client-runtime/routines";

import { useI18n } from "../../i18n";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { NextRunLine, RunHistory, RunTime, runStatusPresentation } from "./RoutineRunHistory";

/** One card in the list: what it is, when it runs next, how it last went, and the way back on. */
/** Per-routine actions the panel forwards to its cards and detail view. */
export interface RoutineActionProps {
  readonly onDryRun?: (routineId: string) => void;
  readonly onApproveProcedure?: (routineId: string) => void;
  readonly onRunNow?: (routineId: string) => void;
  readonly onSetEnabled?: (routineId: string, enabled: boolean) => void;
  readonly onSetPaused?: (routineId: string, paused: boolean) => void;
}

export function RoutineCard({
  routine,
  busy,
  onOpen,
  onSetEnabled,
  onSetPaused,
}: {
  readonly routine: RoutineAdapterItem;
  readonly busy: boolean;
  readonly onOpen: () => void;
} & Pick<RoutineActionProps, "onSetEnabled" | "onSetPaused">) {
  const i18n = useI18n();
  const { t } = i18n;
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
        aria-label={t("Open {name}", { name: routine.name })}
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
            {routineScheduleLabel(routine.schedule, i18n)}
          </span>
        </span>
        <Badge size="sm" variant={status.variant}>
          {t(status.label)}
        </Badge>
        <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground/60" />
      </button>

      <div className="mt-1 space-y-1.5 pl-8">
        <NextRunLine routine={routine} />
        {latest ? (
          <div className="flex min-w-0 items-center gap-1.5">
            <Badge size="sm" variant={runStatusPresentation(latest.status).variant}>
              {t(runStatusPresentation(latest.status).label)}
            </Badge>
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {runSummaryLine(latest, i18n)}
                  </span>
                }
              />
              <TooltipPopup side="top" className="max-w-80">
                {runSummaryLine(latest, i18n)}
              </TooltipPopup>
            </Tooltip>
          </div>
        ) : null}
        {routine.runHistory.length > 0 || reverse ? (
          <div className="flex items-center justify-between gap-2">
            <RunHistory runs={routine.runHistory} />
            {Match.value(reverse).pipe(
              Match.when("resume", () => (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy || !onSetPaused}
                  onClick={() => onSetPaused?.(routine.id, false)}
                >
                  {t("Resume")}
                </Button>
              )),
              Match.when("enable", () => (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy || !onSetEnabled}
                  onClick={() => onSetEnabled?.(routine.id, true)}
                >
                  {t("Enable")}
                </Button>
              )),
              Match.orElse(() => null),
            )}
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
  doneBy = null,
  busy,
  onBack,
  onEdit,
  onDeleteRequest,
  ...actions
}: {
  readonly routine: RoutineAdapterItem;
  readonly projectName: string;
  /** The bot that does each run's work, when it is not the owner. */
  readonly doneBy?: string | null;
  readonly busy: boolean;
  readonly onBack: () => void;
  readonly onEdit: () => void;
  readonly onDeleteRequest: () => void;
} & Pick<
  RoutineActionProps,
  "onApproveProcedure" | "onDryRun" | "onRunNow" | "onSetEnabled" | "onSetPaused"
>) {
  const i18n = useI18n();
  const { t } = i18n;
  const status = routineStatus(routine);
  const latest = routine.latestRun;

  return (
    <div data-testid="routine-detail">
      <div className="flex items-center gap-2">
        <Button
          aria-label={t("Back to routines")}
          data-routine-back=""
          size="icon-sm"
          variant="ghost"
          onClick={onBack}
        >
          <ChevronLeftIcon />
        </Button>
        <h4 className="min-w-0 flex-1 truncate text-sm font-medium">{routine.name}</h4>
        <Badge size="sm" variant={status.variant}>
          {t(status.label)}
        </Badge>
      </div>

      <div className="mt-4 space-y-4">
        <section>
          <h5 className="text-xs font-medium text-muted-foreground">{t("Instructions")}</h5>
          <p className="mt-1 whitespace-pre-wrap text-sm">{routine.prompt}</p>
        </section>

        <section>
          <h5 className="text-xs font-medium text-muted-foreground">{t("When to run")}</h5>
          <p className="mt-1 flex items-center gap-1.5 text-sm">
            <Clock3Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            {routineScheduleLabel(routine.schedule, i18n)}
          </p>
          <dl className="mt-2 space-y-1 text-xs text-muted-foreground">
            <div className="flex gap-2">
              <dt>{t("Next run")}</dt>
              <dd className="text-foreground">{routineDateLabel(routine.nextRunAt, i18n)}</dd>
            </div>
            <div className="flex gap-2">
              <dt>{t("Last run")}</dt>
              <dd className="text-foreground">{routineDateLabel(routine.lastRunAt, i18n)}</dd>
            </div>
            <div className="flex gap-2">
              <dt>{t("Workspace")}</dt>
              <dd className="min-w-0 truncate text-foreground">{projectName}</dd>
            </div>
            {doneBy !== null ? (
              <div className="flex gap-2">
                <dt>{t("Done by")}</dt>
                <dd className="min-w-0 truncate text-foreground">{doneBy}</dd>
              </div>
            ) : null}
          </dl>
        </section>

        {latest ? (
          <section>
            <h5 className="text-xs font-medium text-muted-foreground">{t("Latest run")}</h5>
            <div className="mt-1 flex items-center gap-1.5">
              <Badge size="sm" variant={runStatusPresentation(latest.status).variant}>
                {t(runStatusPresentation(latest.status).label)}
              </Badge>
              <RunTime value={latest.startedAt} className="text-xs text-muted-foreground" />
            </div>
            <p className={`mt-1 text-sm ${latest.error ? "text-destructive" : ""}`}>
              {runSummaryLine(latest, i18n)}
            </p>
            <div className="mt-2">
              <RunHistory runs={routine.runHistory} />
            </div>
          </section>
        ) : null}

        {!routine.procedureApproved ? (
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5">
            <p className="text-xs text-muted-foreground">
              {t("This routine runs only once you approve its procedure.")}
            </p>
            <Button
              className="mt-2"
              size="xs"
              disabled={busy || !actions.onApproveProcedure}
              onClick={() => actions.onApproveProcedure?.(routine.id)}
            >
              {t("Approve procedure")}
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
              {t("Resume")}
            </Button>
          ) : !routine.enabled && routine.procedureApproved ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy || !actions.onSetEnabled}
              onClick={() => actions.onSetEnabled?.(routine.id, true)}
            >
              {t("Enable")}
            </Button>
          ) : routine.enabled ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy || !actions.onSetPaused}
              onClick={() => actions.onSetPaused?.(routine.id, true)}
            >
              {t("Pause")}
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="outline"
            disabled={busy || !actions.onDryRun}
            onClick={() => actions.onDryRun?.(routine.id)}
          >
            {t("Test")}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={busy || !routine.procedureApproved || !actions.onRunNow}
            onClick={() => actions.onRunNow?.(routine.id)}
          >
            {t("Run now")}
          </Button>
          <Button size="xs" variant="ghost" disabled={busy} onClick={onEdit}>
            {t("Edit")}
          </Button>
          <Button size="xs" variant="destructive-outline" disabled={busy} onClick={onDeleteRequest}>
            {t("Delete")}
          </Button>
        </div>
      </div>
    </div>
  );
}
