import { useEffect, useRef, type CSSProperties } from "react";

import { useI18n } from "~/i18n";
import { cn } from "~/lib/utils";

/*
 * The one status line a waiting turn gets: a 3x3 meter, a shimmering label, and
 * an elapsed timer in tabular figures. Adapted from the "Drive" loading state in
 * Beautiful UI (MIT © 2026 Shane Levine). Akeru keeps the chevron wavefront but
 * plays it once: the meter sweeps right when it appears and whenever the step
 * label changes, then rests on a lit chevron. Nothing loops while a turn runs.
 *
 * Reduced motion skips the sweep and shows the resting chevron. The timer still
 * ticks once a second, because elapsed time is information rather than decoration.
 */

/** Chevron wavefront: each cell lights (column + distance from the middle row) x 90ms later. */
export const LOADER_CELL_DELAYS_MS: readonly number[] = Array.from({ length: 9 }, (_, index) => {
  const row = Math.floor(index / 3);
  const column = index % 3;
  return (column + Math.abs(row - 1)) * 90;
});

/** Cells that stay lit after the sweep, drawing a right-pointing chevron. */
export const LOADER_RESTING_CELLS: readonly boolean[] = Array.from({ length: 9 }, (_, index) => {
  const row = Math.floor(index / 3);
  const column = index % 3;
  return column === 2 - Math.abs(row - 1);
});

/** `4s` under a minute, then `1m 04s`. Kept short so the line never reflows. */
export function formatLoadingElapsed(elapsedMs: number): string {
  const elapsedSeconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = Math.floor(elapsedSeconds % 60);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function LoaderMeter({ className }: { readonly className?: string }) {
  return (
    <span aria-hidden="true" className={cn("grid shrink-0 grid-cols-3 gap-[3px]", className)}>
      {LOADER_CELL_DELAYS_MS.map((delay, index) => (
        <i
          key={`r${Math.floor(index / 3)}c${index % 3}`}
          className="response-loading-pixel size-1 rounded-[1px] bg-current"
          data-lit={LOADER_RESTING_CELLS[index] ? "" : undefined}
          style={{ animationDelay: `${delay}ms` } as CSSProperties}
        />
      ))}
    </span>
  );
}

/** Elapsed label that writes its own text node, so ticking never commits React. */
function LoadingElapsed({ startedAt }: { readonly startedAt: number }) {
  const textRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const update = () => {
      if (textRef.current) {
        textRef.current.textContent = formatLoadingElapsed(Date.now() - startedAt);
      }
    };
    update();
    const intervalId = window.setInterval(update, 1000);
    return () => window.clearInterval(intervalId);
  }, [startedAt]);

  return (
    <span
      ref={textRef}
      className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground"
      data-testid="response-loading-time"
    >
      {formatLoadingElapsed(Date.now() - startedAt)}
    </span>
  );
}

export function ResponseLoadingState({
  createdAt,
  label: labelOverride,
  className,
}: {
  /** Turn start; omit or pass `null` to hide the timer. */
  readonly createdAt: string | null;
  readonly label?: string;
  readonly className?: string;
}) {
  const { t } = useI18n();
  const label = labelOverride ?? t("Working");
  const startedAt = createdAt ? Date.parse(createdAt) : Number.NaN;
  const showTimer = Number.isFinite(startedAt);

  return (
    <div
      role="status"
      aria-label={showTimer ? t("{label}, elapsed time updating", { label }) : label}
      className={cn("flex min-w-0 items-center gap-2 text-muted-foreground", className)}
      data-testid="response-loading-state"
    >
      {/* Keyed by label so a new step replays the one-shot sweep. */}
      <LoaderMeter key={label} />
      <span className="bot-status-shimmer min-w-0 truncate text-[13px] font-medium">{label}</span>
      {showTimer ? <LoadingElapsed startedAt={startedAt} /> : null}
    </div>
  );
}
