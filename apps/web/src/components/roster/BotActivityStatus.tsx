import type { OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import { ResponseLoadingState } from "../chat/ResponseLoadingState";
import { BotAvatarView } from "./BotAvatarView";
import type { BotAvatar } from "./types";

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
 * rather than dropped, so a new tool still says something true.
 */
export function botActivityUpdate(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: TurnId | null,
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
  if (/browser snapshot|snapshot/.test(normalized)) return "Reading the page";
  if (/browser navigate|preview open|open browser/.test(normalized)) return "Opening a page";
  if (/browser click/.test(normalized)) return "Using the page";
  if (/browser type/.test(normalized)) return "Entering text";
  if (/search|web query/.test(normalized)) return "Searching the web";
  if (/test|typecheck|lint|check/.test(normalized)) return "Running checks";
  if (/patch|edit|write/.test(normalized)) return "Editing files";
  if (/command|shell|exec/.test(normalized)) return "Running a command";
  if (/read|fetch|open/.test(normalized)) return "Reading a source";
  if (/task|agent/.test(normalized)) return "Coordinating work";
  if (!summary) return null;
  const label = `${summary[0]?.toUpperCase() ?? ""}${summary.slice(1)}`;
  return label.length > 56 ? `${label.slice(0, 55).trimEnd()}…` : label;
}

export function BotActivityStatus({
  avatar,
  name,
  startedAt = null,
  compact = false,
  update = null,
}: {
  readonly avatar: BotAvatar;
  readonly name: string;
  /** Turn start; when known the status shows a live elapsed timer. */
  readonly startedAt?: string | null;
  /** Drops the avatar for rails that already show who is working. */
  readonly compact?: boolean;
  readonly update?: string | null;
}) {
  return (
    // ResponseLoadingState owns the live region; announcing from here too would nest them.
    <div className="flex min-w-0 items-center gap-2.5 text-sm" data-testid="bot-activity-status">
      {compact ? null : (
        <BotAvatarView avatar={avatar} name={name} className="size-7 shrink-0" state="working" />
      )}
      <ResponseLoadingState
        createdAt={startedAt}
        label={update ? `${name} · ${update}` : `${name} is working`}
      />
    </div>
  );
}
