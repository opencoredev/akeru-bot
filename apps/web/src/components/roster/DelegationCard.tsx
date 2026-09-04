import type {
  AkeruDelegationAccessGrant,
  AkeruDelegationRecord,
  AkeruDelegationState,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";

import { deriveLatestContextWindowSnapshot } from "../../lib/contextWindow";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useThreadActivities, useThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { BotAvatarView } from "./BotAvatarView";
import { useRosterStore } from "./rosterStore";
import type { Bot } from "./types";

const TERMINAL_STATES = new Set<AkeruDelegationState>(["failed", "canceled", "completed"]);

const STATE_DOT: Record<AkeruDelegationState, string> = {
  queued: "bg-muted-foreground/50",
  running: "bg-info",
  blocked: "bg-warning",
  failed: "bg-destructive",
  canceled: "bg-muted-foreground/60",
  completed: "bg-success",
};

const RUNTIME_MODE_LABEL: Record<AkeruDelegationAccessGrant["runtimeMode"], string> = {
  "approval-required": "approval required",
  "auto-accept-edits": "auto-accept edits",
  auto: "automatic approvals",
  "full-access": "full access",
};

function formatDelegationAccess(access: AkeruDelegationAccessGrant): string {
  return [
    RUNTIME_MODE_LABEL[access.runtimeMode],
    access.sandbox === null ? "no sandbox" : `${access.sandbox} sandbox`,
    `tools: ${access.allowedToolIds.join(", ") || "none"}`,
    `memory: ${access.memoryScopes.join(", ") || "none"}`,
    `MCP servers: ${access.enabledMcpServerIds.length}`,
    access.hasUserComputer ? "user computer" : "no user computer",
    access.approvalCeiling === "none"
      ? "no approvals"
      : `approval ceiling: ${access.approvalCeiling}`,
  ].join(" · ");
}

export function delegationUsageTokens(
  delegation: AkeruDelegationRecord,
  childActivities: ReadonlyArray<OrchestrationThreadActivity>,
): number | null {
  if (!delegation.childTurnId) return null;
  const activities = childActivities.filter(
    (activity) => activity.turnId === delegation.childTurnId,
  );
  const usage = deriveLatestContextWindowSnapshot(activities);
  return usage?.totalProcessedTokens ?? usage?.usedTokens ?? null;
}

function delegationElapsed(delegation: AkeruDelegationRecord, now = Date.now()): string | null {
  const startedAt = Date.parse(delegation.startedAt ?? delegation.createdAt);
  const endedAt = delegation.completedAt ? Date.parse(delegation.completedAt) : now;
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt) return null;
  return formatDuration(endedAt - startedAt);
}

function DelegationElapsed({ delegation }: { readonly delegation: AkeruDelegationRecord }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const live = !TERMINAL_STATES.has(delegation.state);

  useEffect(() => {
    if (!live) return;
    const update = () => {
      if (textRef.current) textRef.current.textContent = delegationElapsed(delegation) ?? "";
    };
    update();
    const id = window.setInterval(update, 1_000);
    return () => window.clearInterval(id);
  }, [delegation, live]);

  const elapsed = delegationElapsed(delegation);
  return elapsed ? (
    <span ref={textRef} className="tabular-nums">
      {elapsed}
    </span>
  ) : null;
}

export function DelegationCard({
  delegation,
  childBot,
}: {
  readonly delegation: AkeruDelegationRecord;
  readonly childBot: Bot | null;
}) {
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const cancelDelegation = useAtomCommand(orchestrationEnvironment.cancelDelegation, {
    reportFailure: false,
  });
  const childThreadRef = useMemo(
    () =>
      environmentId && delegation.childThreadId
        ? scopeThreadRef(environmentId, delegation.childThreadId)
        : null,
    [delegation.childThreadId, environmentId],
  );
  const childThread = useThreadShell(childThreadRef);
  const childActivities = useThreadActivities(childThreadRef);
  const activeChildBot = childBot?.archivedAt === null ? childBot : null;
  const childName = activeChildBot?.name ?? "Unknown bot";
  const usageTokens = childThread ? delegationUsageTokens(delegation, childActivities) : null;
  const canCancel = !TERMINAL_STATES.has(delegation.state) && environmentId !== null;
  const canOpen = activeChildBot !== null && childThread !== null && environmentId !== null;
  const outcome =
    delegation.failure?.message ??
    delegation.result?.summary ??
    (delegation.state === "failed"
      ? "Failure details unavailable"
      : delegation.state === "completed"
        ? "Result unavailable"
        : null);

  return (
    <article
      aria-label={`Delegation to ${childName}`}
      className="ml-10 max-w-[min(42rem,calc(100%-2.5rem))] border-l-2 border-border py-1.5 pl-3"
      data-testid="delegation-card"
    >
      <div className="flex min-w-0 items-center gap-2">
        <BotAvatarView
          avatar={activeChildBot?.avatar ?? { kind: "dither", seed: delegation.childBotId }}
          name={childName}
          className="size-7 shrink-0"
        />
        <span className="min-w-0 truncate text-sm font-medium">{childName}</span>
        <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span aria-hidden className={`size-1.5 rounded-full ${STATE_DOT[delegation.state]}`} />
          <span aria-live="polite">{delegation.state}</span>
        </span>
      </div>
      <p className="mt-1 line-clamp-2 text-sm leading-5">{delegation.task}</p>
      <p className="mt-1 break-words text-xs text-muted-foreground">
        {formatDelegationAccess(delegation.access)}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        <DelegationElapsed delegation={delegation} />
        <span
          className="tabular-nums"
          aria-label={
            usageTokens === null
              ? `Usage unavailable for ${childName}`
              : `${usageTokens.toLocaleString()} tokens billed to ${childName}`
          }
        >
          {usageTokens === null ? "Usage unavailable" : `${formatTokens(usageTokens)} tokens`}
        </span>
      </div>
      {outcome ? (
        <p
          className={`mt-1 text-sm leading-5 ${delegation.failure ? "text-destructive-foreground" : "text-muted-foreground"}`}
        >
          {outcome}
        </p>
      ) : null}
      <div className="mt-1.5 flex items-center gap-1">
        {canCancel ? (
          <Button
            size="sm"
            variant="ghost-muted"
            className="min-h-11"
            aria-label={`Cancel delegation to ${childName}`}
            onClick={() => {
              void cancelDelegation({
                environmentId,
                input: { delegationId: delegation.delegationId, keep: false },
              }).then((result) => {
                if (result._tag === "Failure") {
                  toastManager.add({ type: "error", title: "Could not cancel delegation" });
                }
              });
            }}
          >
            Cancel
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost-muted"
          className="min-h-11"
          aria-label={`Open ${childName} chat`}
          disabled={!canOpen}
          onClick={() => {
            if (!canOpen) return;
            useRosterStore
              .getState()
              .recordChatPath(activeChildBot.id, `/${environmentId}/${childThread.id}`);
            void navigate({ to: "/bots/$botId", params: { botId: activeChildBot.id } });
          }}
        >
          Open chat
        </Button>
      </div>
    </article>
  );
}
