import { useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import {
  absoluteRunTime,
  boundedRunHistory,
  relativeRunTime,
  routineStateNote,
  runStatusTone,
  runSummaryLine,
  type RoutineAdapterItem,
  type RoutineAdapterRun,
  type RoutineAdapterRunStatus,
} from "@akeru/client-runtime/routines";

import { useI18n } from "../../i18n";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const RUN_STATUS_DOT = {
  success: "bg-success",
  error: "bg-destructive",
  info: "bg-info",
  secondary: "bg-muted-foreground",
  warning: "bg-warning",
} as const;

/** How one run reads at a glance: its chip wording, its badge colour, and its history dot. */
export function runStatusPresentation(status: RoutineAdapterRunStatus) {
  const tone = runStatusTone(status);

  return { ...tone, dot: RUN_STATUS_DOT[tone.variant] };
}

/** A relative time that keeps its exact instant one hover away. */
export function RunTime({
  value,
  className,
}: {
  readonly value: string;
  readonly className?: string;
}) {
  const i18n = useI18n();
  const absolute = absoluteRunTime(value, i18n);

  if (!absolute) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className={className}>{relativeRunTime(value, Date.now(), i18n)}</span>}
      />
      <TooltipPopup side="top">{absolute}</TooltipPopup>
    </Tooltip>
  );
}

/** The outcome of one run on a single line: status, when, and what it said. */
function RunLine({ run }: { readonly run: RoutineAdapterRun }) {
  const i18n = useI18n();
  const presentation = runStatusPresentation(run.status);

  return (
    <li className="flex items-baseline gap-2 text-xs">
      <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${presentation.dot}`} />
      <span className="sr-only">{i18n.t(presentation.label)}</span>
      <RunTime value={run.startedAt} className="shrink-0 tabular-nums text-muted-foreground" />
      <span className={`min-w-0 flex-1 truncate ${run.error ? "text-destructive" : ""}`}>
        {runSummaryLine(run, i18n)}
      </span>
    </li>
  );
}

/** Past runs, newest first, kept out of the way behind their own count until asked for. */
export function RunHistory({ runs }: { readonly runs: readonly RoutineAdapterRun[] }) {
  const { plural } = useI18n();
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
        {plural(runs.length, { one: "{count} run", other: "{count} runs" })}
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
export function NextRunLine({ routine }: { readonly routine: RoutineAdapterItem }) {
  const { t } = useI18n();
  const stateNote = routineStateNote(routine);

  if (stateNote) {
    return <p className="text-xs text-muted-foreground">{t(stateNote)}</p>;
  }

  if (!routine.nextRunAt) {
    return <p className="text-xs text-muted-foreground">{t("No next run scheduled.")}</p>;
  }

  return (
    <p className="text-xs text-muted-foreground">
      {t("Next run")} <RunTime value={routine.nextRunAt} className="text-foreground" />
    </p>
  );
}
