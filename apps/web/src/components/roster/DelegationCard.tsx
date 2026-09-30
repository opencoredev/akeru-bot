import type {
  AkeruDelegationRecord,
  AkeruDelegationState,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";
import {
  delegationElapsedMs,
  presentDelegation,
} from "@t3tools/client-runtime/delegation-presentation";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { useMemo, useState, type ReactNode } from "react";

import { useI18n } from "../../i18n";
import { deriveLatestContextWindowSnapshot } from "../../lib/contextWindow";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useThreadActivities, useThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { BotAvatarView } from "./BotAvatarView";
import { DelegationDetail, delegationStateLabel, formatDelegationAccess } from "./DelegationDetail";
import { useDelegationClock } from "./delegationClock";
import type { Bot } from "./types";

const STATE_DOT: Record<AkeruDelegationState, string> = {
  queued: "bg-muted-foreground/50",
  running: "bg-info",
  blocked: "bg-warning",
  failed: "bg-destructive",
  canceled: "bg-muted-foreground/60",
  completed: "bg-success",
};

export function delegationUsageTokens(
  delegation: AkeruDelegationRecord,
  childActivities: ReadonlyArray<OrchestrationThreadActivity>,
): number | null {
  const childTurnId = delegation.phase._tag === "Queued" ? null : delegation.phase.childTurnId;
  if (!childTurnId) return null;
  const activities = childActivities.filter((activity) => activity.turnId === childTurnId);
  const usage = deriveLatestContextWindowSnapshot(activities);
  return usage?.totalProcessedTokens ?? usage?.usedTokens ?? null;
}

function DelegationElapsed({
  delegation,
  live,
}: {
  readonly delegation: AkeruDelegationRecord;
  readonly live: boolean;
}) {
  const now = useDelegationClock(live);
  const elapsed = delegationElapsedMs(delegation, now);
  return elapsed === null ? null : <span className="tabular-nums">{formatDuration(elapsed)}</span>;
}

function DelegationCancelAction({
  delegation,
  childName,
}: {
  readonly delegation: AkeruDelegationRecord;
  readonly childName: string;
}) {
  const { t } = useI18n();
  const environmentId = usePrimaryEnvironmentId();
  const cancelDelegation = useAtomCommand(orchestrationEnvironment.cancelDelegation, {
    reportFailure: false,
  });
  if (environmentId === null) return null;
  return (
    <Button
      size="sm"
      variant="ghost-muted"
      className="min-h-11"
      aria-label={t("Cancel delegation to {name}", { name: childName })}
      onClick={() => {
        void cancelDelegation({
          environmentId,
          input: { delegationId: delegation.delegationId, keep: false },
        }).then((result) => {
          if (result._tag === "Failure") {
            toastManager.add({ type: "error", title: t("Could not cancel delegation") });
          }
        });
      }}
    >
      {t("Cancel")}
    </Button>
  );
}

/**
 * One piece of delegated work in the parent chat's timeline. The face shows who
 * is working, the task, progress, and the outcome. The access grant sits behind
 * Details, and View work opens the child's chat read-only.
 *
 * `actions` replaces the default Cancel control, so the reverse-state menu
 * (retry, let it finish, cancel) can own that slot. `variant="group"` names the
 * bot that asked, because a group room has several bots who can delegate.
 */
export function DelegationCard({
  delegation,
  childBot,
  parentBot,
  variant = "bot",
  actions,
}: {
  readonly delegation: AkeruDelegationRecord;
  readonly childBot: Bot | null;
  readonly parentBot: Bot | null;
  readonly variant?: "bot" | "group";
  readonly actions?: ReactNode;
}) {
  const { t } = useI18n();
  const environmentId = usePrimaryEnvironmentId();
  const [detailOpen, setDetailOpen] = useState(false);
  const presentation = presentDelegation(delegation);
  const childThreadRef = useMemo(
    () =>
      environmentId && presentation.childThreadId
        ? scopeThreadRef(environmentId, presentation.childThreadId)
        : null,
    [presentation.childThreadId, environmentId],
  );
  const childThread = useThreadShell(childThreadRef);
  const childActivities = useThreadActivities(childThreadRef);
  const activeChildBot = childBot?.archivedAt === null ? childBot : null;
  const state = presentation.state;
  const childName = activeChildBot?.name ?? t("Unknown bot");
  const parentName = parentBot?.name ?? t("Unknown bot");
  const usageTokens = childThread ? delegationUsageTokens(delegation, childActivities) : null;
  const outcome = presentation.outcome
    ? presentation.outcome.text ||
      (presentation.outcome.kind === "failure"
        ? t("Failure details unavailable")
        : presentation.outcome.kind === "result"
          ? t("Result unavailable")
          : null)
    : null;

  return (
    <article
      aria-label={t("Delegation to {name}", { name: childName })}
      className="mt-2 ml-10 max-w-[min(42rem,calc(100%-2.5rem))] border-l-2 border-border py-1.5 pl-3"
      data-testid="delegation-card"
      data-delegation-id={delegation.delegationId}
    >
      <div className="flex min-w-0 items-center gap-2">
        <BotAvatarView
          avatar={activeChildBot?.avatar ?? { kind: "dither", seed: delegation.childBotId }}
          name={childName}
          className="size-7 shrink-0"
        />
        <span className="min-w-0 truncate text-sm font-medium">
          {variant === "group"
            ? t("{parent} asked {child}", { parent: parentName, child: childName })
            : childName}
        </span>
        {presentation.trigger === "scheduled" ? (
          <span className="shrink-0 text-xs text-muted-foreground">{t("Scheduled")}</span>
        ) : null}
        {presentation.retried ? (
          <span className="shrink-0 text-xs text-muted-foreground">{t("Retried")}</span>
        ) : null}
        <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span aria-hidden className={`size-1.5 rounded-full ${STATE_DOT[state]}`} />
          <span aria-live="polite">{delegationStateLabel(state, t)}</span>
        </span>
      </div>
      <p className="mt-1 line-clamp-2 text-sm leading-5">{delegation.task}</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        <DelegationElapsed delegation={delegation} live={!presentation.terminal} />
        <span
          className="tabular-nums"
          aria-label={
            usageTokens === null
              ? t("Usage unavailable for {name}", { name: childName })
              : t("{tokens} tokens billed to {name}", {
                  tokens: usageTokens.toLocaleString(),
                  name: childName,
                })
          }
        >
          {usageTokens === null
            ? t("Usage unavailable")
            : t("{tokens} tokens", { tokens: formatTokens(usageTokens) })}
        </span>
      </div>
      {outcome ? (
        <p
          className={`mt-1 text-sm leading-5 ${delegation.phase._tag === "Failed" ? "text-destructive-foreground" : "text-muted-foreground"}`}
        >
          {outcome}
        </p>
      ) : null}
      {presentation.delivery ? (
        <p className="mt-1 text-xs text-muted-foreground" data-delivery={presentation.delivery}>
          {presentation.delivery === "pending"
            ? t("Result waiting for the next reply")
            : t("Result delivered to {name}", { name: parentName })}
        </p>
      ) : null}
      <details className="mt-1 text-xs text-muted-foreground" data-delegation-details>
        <summary className="min-h-11 w-fit content-center">{t("Details")}</summary>
        <dl className="flex flex-col gap-1 pb-1">
          <div>
            <dt className="font-medium">{t("Expected result")}</dt>
            <dd className="break-words">{delegation.expectedResult}</dd>
          </div>
          <div>
            <dt className="font-medium">{t("Access")}</dt>
            <dd className="break-words">{formatDelegationAccess(delegation.access, t)}</dd>
          </div>
        </dl>
      </details>
      <div className="flex items-center gap-1" data-delegation-actions>
        {actions ??
          (presentation.terminal ? null : (
            <DelegationCancelAction delegation={delegation} childName={childName} />
          ))}
        <Button
          size="sm"
          variant="ghost-muted"
          className="min-h-11"
          aria-label={t("View {name}'s work", { name: childName })}
          disabled={presentation.childThreadId === null || environmentId === null}
          onClick={() => setDetailOpen(true)}
        >
          {t("View work")}
        </Button>
      </div>
      {detailOpen ? (
        <DelegationDetail
          delegation={delegation}
          childBot={childBot}
          parentBot={parentBot}
          onOpenChange={setDetailOpen}
        />
      ) : null}
    </article>
  );
}
