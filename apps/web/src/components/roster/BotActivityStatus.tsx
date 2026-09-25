import type { MessageKey } from "@t3tools/client-runtime/i18n";
import type { ThreadSilentRun } from "@t3tools/client-runtime/silent-run";
import type { OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import { useI18n } from "../../i18n";

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

export function BotActivityStatus({
  avatar,
  name,
  startedAt = null,
  compact = false,
  update = null,
  silentRun = null,
}: {
  readonly avatar: BotAvatar;
  readonly name: string;
  /** Turn start; when known the status shows a live elapsed timer. */
  readonly startedAt?: string | null;
  /** Drops the avatar for rails that already show who is working. */
  readonly compact?: boolean;
  readonly update?: string | null;
  /** A running turn the provider went quiet on; replaces the working label and timer. */
  readonly silentRun?: ThreadSilentRun | null;
}) {
  const { t } = useI18n();
  if (silentRun) {
    return (
      <div
        className="flex min-w-0 items-center gap-2.5 text-sm"
        data-testid="bot-activity-status"
        data-silent-run=""
      >
        {compact ? null : (
          <BotAvatarView avatar={avatar} name={name} className="size-7 shrink-0" state="working" />
        )}
        {/* The timer counts from the last output, so it reads as how long it has been quiet. */}
        <ResponseLoadingState
          createdAt={silentRun.lastActivityAt}
          label={t("No response from {provider}", { provider: silentRun.providerName })}
          stalled
        />
      </div>
    );
  }
  return (
    // ResponseLoadingState owns the live region; announcing from here too would nest them.
    <div className="flex min-w-0 items-center gap-2.5 text-sm" data-testid="bot-activity-status">
      {compact ? null : (
        <BotAvatarView avatar={avatar} name={name} className="size-7 shrink-0" state="working" />
      )}
      <ResponseLoadingState
        createdAt={startedAt}
        label={update ? `${name} · ${update}` : t("{name} is working", { name })}
      />
    </div>
  );
}
