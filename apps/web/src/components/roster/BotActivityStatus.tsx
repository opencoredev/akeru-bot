import type { MessageKey } from "@t3tools/client-runtime/i18n";
import type { ThreadSilentRun } from "@t3tools/client-runtime/silent-run";
import type { OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";
import type { CSSProperties } from "react";

import { useI18n } from "../../i18n";
import { cn } from "~/lib/utils";

import { ResponseLoadingState } from "../chat/ResponseLoadingState";
import type { BotActivity } from "./botActivityStatus.logic";

const HIDDEN_ACTIVITY_KINDS = new Set([
  "checkpoint.captured",
  "context-window.updated",
  "thread.started",
  "turn.started",
]);

/**
 * The one short phrase describing what the bot is doing right now, or null when the
 * latest action already finished and there is nothing more specific than "working".
 * Provider tool names are mapped to plain language; anything unrecognized is trimmed
 * rather than dropped, so a new tool still says something true. Pass the view's `t` so
 * the plain-language phrases follow the interface language; provider summaries stay raw.
 */
export function botActivityUpdate(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: TurnId | null,
  t: (key: MessageKey) => string = (key) => key,
): string | null {
  if (!turnId) return null;
  const activity = activities.findLast(
    (candidate) =>
      candidate.turnId === turnId &&
      !HIDDEN_ACTIVITY_KINDS.has(candidate.kind) &&
      (candidate.tone === "tool" || candidate.kind.startsWith("task.")),
  );
  if (!activity) return null;
  if (
    /(?:completed|failed|stopped)$/i.test(activity.kind) ||
    /\s+(?:completed|failed|stopped)$/i.test(activity.summary)
  ) {
    return null;
  }

  const summary = activity.summary
    .replace(/\s+started$/i, "")
    .replaceAll("_", " ")
    .trim();
  const normalized = summary.toLowerCase();
  if (/ask user|user input|structured question/.test(normalized)) return null;
  if (/browser snapshot|snapshot/.test(normalized)) return t("Reading the page");
  if (/browser navigate|preview open|open browser/.test(normalized)) return t("Opening a page");
  if (/browser click/.test(normalized)) return t("Using the page");
  if (/browser type/.test(normalized)) return t("Entering text");
  if (/search|web query/.test(normalized)) return t("Searching the web");
  if (/test|typecheck|lint|check/.test(normalized)) return t("Running checks");
  if (/patch|edit|write/.test(normalized)) return t("Editing files");
  if (/command|shell|exec/.test(normalized)) return t("Running a command");
  if (/read|fetch|open/.test(normalized)) return t("Reading a source");
  if (/task|agent/.test(normalized)) return t("Coordinating work");
  if (!summary) return null;
  const label = `${summary[0]?.toUpperCase() ?? ""}${summary.slice(1)}`;
  return label.length > 56 ? `${label.slice(0, 55).trimEnd()}…` : label;
}

// Eight cells of a 5x5 diamond, clockwise from the top. The comet head steps
// around this ring; each cell's delay puts it one step behind the previous one.
const GLYPH_CELLS = [
  [2, 0],
  [3, 1],
  [4, 2],
  [3, 3],
  [2, 4],
  [1, 3],
  [0, 2],
  [1, 1],
] as const;

/** The pixel comet from the thinking row. Opacity only, so it stays on the compositor. */
export function PixelThinkingGlyph({ className }: { readonly className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={cn("bot-thinking-glyph size-3.5 shrink-0", className)}
      viewBox="0 0 14 14"
    >
      {GLYPH_CELLS.map(([x, y], index) => (
        <rect
          fill="currentColor"
          height="2"
          key={`${x}-${y}`}
          style={{ "--cell": index } as CSSProperties}
          width="2"
          x={x * 3}
          y={y * 3}
        />
      ))}
    </svg>
  );
}

/** Text with a soft sheen sweeping across it while work is in progress. */
function ShimmerText({ text, className }: { readonly text: string; readonly className?: string }) {
  return (
    <span className={cn("bot-shimmer-text", className)}>
      {text}
      <span aria-hidden="true" className="bot-shimmer-sheen">
        <span className="bot-shimmer-sheen-text">{text}</span>
      </span>
    </span>
  );
}

/**
 * The moving diamond and a short update. What the bot is doing in detail stays out of view.
 * `activity` comes from the reported tool action; `update` is the older summary-based
 * phrase and fills in when no tool action is known yet. A run the provider went quiet
 * on replaces both with a stalled timer counting from the last output.
 */
export function BotActivityStatus({
  name,
  activity = null,
  update = null,
  silentRun = null,
}: {
  readonly name: string;
  readonly activity?: BotActivity | null;
  readonly update?: string | null;
  readonly silentRun?: ThreadSilentRun | null;
}) {
  const { t } = useI18n();
  if (silentRun) {
    return (
      <div
        className="flex w-full min-w-0 items-center gap-3 py-1 text-sm"
        data-testid="bot-activity-status"
        data-silent-run=""
      >
        <span className="flex w-7 shrink-0 justify-center">
          <PixelThinkingGlyph className="text-muted-foreground" />
        </span>
        <ResponseLoadingState
          createdAt={silentRun.lastActivityAt}
          label={t("No response from {provider}", { provider: silentRun.providerName })}
          stalled
        />
      </div>
    );
  }
  const label = activity?.label ?? update ?? t("{name} is working", { name });
  return (
    <div
      aria-live="polite"
      className="flex w-full min-w-0 items-center gap-3 py-1 text-sm"
      data-testid="bot-activity-status"
    >
      {/* Same 28px column as a message avatar, so the text lines up with message text. */}
      <span className="flex w-7 shrink-0 justify-center">
        <PixelThinkingGlyph className="text-foreground" />
      </span>
      <span className="sr-only">{name}: </span>
      <ShimmerText
        className="min-w-0 truncate font-medium text-foreground"
        key={label}
        text={`${label}...`}
      />
    </div>
  );
}
