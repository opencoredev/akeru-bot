import type {
  AkeruDelegationRecord,
  AkeruDelegationState,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";
import {
  type DelegationAction,
  delegationActions,
  delegationElapsedMs,
  presentDelegation,
} from "@t3tools/client-runtime/delegation-presentation";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
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

function commandFailureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]) {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : undefined;
}

/**
 * The reverse-state controls for one piece of bot work. Only the moves
 * `delegationActions` allows show: Let it finish and Cancel while the work is
 * live, Try again once it failed or was canceled and has not been retried yet.
 * Every button stays disabled
 * while a command is in flight.
 */
function DelegationActions({
  delegation,
  delegations,
  childName,
}: {
  readonly delegation: AkeruDelegationRecord;
  readonly delegations: ReadonlyArray<AkeruDelegationRecord>;
  readonly childName: string;
}) {
  const { t } = useI18n();
  const environmentId = usePrimaryEnvironmentId();
  const [pending, setPending] = useState<DelegationAction | null>(null);
  const cancelDelegation = useAtomCommand(orchestrationEnvironment.cancelDelegation, {
    reportFailure: false,
  });
  const retryDelegation = useAtomCommand(orchestrationEnvironment.retryDelegation, {
    reportFailure: false,
  });
  const actions = delegationActions(delegation, delegations);
  if (environmentId === null || actions.length === 0) return null;

  const run = (action: DelegationAction) => {
    const { delegationId } = delegation;
    setPending(action);
    const request =
      action === "retry"
        ? retryDelegation({ environmentId, input: { delegationId } })
        : cancelDelegation({ environmentId, input: { delegationId, keep: action === "keep" } });
    return request
      .then((result) => {
        if (result._tag !== "Failure") return;
        const description = commandFailureMessage(result);
        toastManager.add({
          type: "error",
          title: actionCopy(action, t, childName).failure,
          ...(description ? { description } : {}),
        });
      })
      .finally(() => setPending(null));
  };

  return actions.map((action) => {
    const copy = actionCopy(action, t, childName);
    return (
      <Button
        key={action}
        size="sm"
        variant="ghost-muted"
        className="min-h-11"
        disabled={pending !== null}
        aria-busy={pending === action || undefined}
        aria-label={copy.ariaLabel}
        onClick={() => run(action)}
      >
        {copy.label}
      </Button>
    );
  });
}

type Translate = ReturnType<typeof useI18n>["t"];

function actionCopy(action: DelegationAction, t: Translate, name: string) {
  switch (action) {
    case "keep":
      return {
        label: t("Let it finish"),
        ariaLabel: t("Let {name} finish the work", { name }),
        failure: t("Could not let the work finish"),
      };
    case "cancel":
      return {
        label: t("Cancel"),
        ariaLabel: t("Cancel delegation to {name}", { name }),
        failure: t("Could not cancel delegation"),
      };
    case "retry":
      return {
        label: t("Try again"),
        ariaLabel: t("Ask {name} to try again", { name }),
        failure: t("Could not retry the work"),
      };
  }
}

/**
 * One piece of delegated work in the parent chat's timeline. The face shows who
 * is working, the task, progress, and the outcome. The access grant sits behind
 * Details, and View work opens the child's chat read-only.
 *
 * The actions slot defaults to the reverse-state controls (let it finish,
 * cancel, try again); a caller can pass `actions` to replace them.
 * `variant="group"` names the bot that asked, because a group room has several
 * bots who can delegate. `delegations` is the chat's full list, so a card that
 * was already retried stops offering Try again.
 */
export function DelegationCard({
  delegation,
  delegations,
  childBot,
  parentBot,
  variant = "bot",
  actions,
}: {
  readonly delegation: AkeruDelegationRecord;
  readonly delegations: ReadonlyArray<AkeruDelegationRecord>;
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
        {actions ?? (
          <DelegationActions
            delegation={delegation}
            delegations={delegations}
            childName={childName}
          />
        )}
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
