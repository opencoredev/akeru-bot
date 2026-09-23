import type {
  AkeruDelegationAccessGrant,
  AkeruDelegationRecord,
  AkeruDelegationState,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { MessageKey, TranslationParams } from "@t3tools/client-runtime/i18n";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";

import { useI18n } from "../../i18n";
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

type Translate = (key: MessageKey, params?: TranslationParams) => string;

function runtimeModeLabel(mode: AkeruDelegationAccessGrant["runtimeMode"], t: Translate): string {
  switch (mode) {
    case "approval-required":
      return t("approval required");
    case "auto-accept-edits":
      return t("auto-accept edits");
    case "auto":
      return t("automatic approvals");
    case "full-access":
      return t("full access");
  }
}

function delegationStateLabel(state: AkeruDelegationState, t: Translate): string {
  switch (state) {
    case "queued":
      return t("queued");
    case "running":
      return t("running");
    case "blocked":
      return t("blocked");
    case "failed":
      return t("failed");
    case "canceled":
      return t("canceled");
    case "completed":
      return t("completed");
  }
}

// Sandbox, tool, memory scope, and approval ceiling values are identifiers and stay raw.
function formatDelegationAccess(access: AkeruDelegationAccessGrant, t: Translate): string {
  return [
    runtimeModeLabel(access.runtimeMode, t),
    access.sandbox === null ? t("no sandbox") : t("{sandbox} sandbox", { sandbox: access.sandbox }),
    t("tools: {tools}", { tools: access.allowedToolIds.join(", ") || t("none") }),
    t("memory: {scopes}", { scopes: access.memoryScopes.join(", ") || t("none") }),
    t("MCP servers: {count}", { count: access.enabledMcpServerIds.length }),
    access.hasUserComputer ? t("user computer") : t("no user computer"),
    access.approvalCeiling === "none"
      ? t("no approvals")
      : t("approval ceiling: {ceiling}", { ceiling: access.approvalCeiling }),
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
  const { t } = useI18n();
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
  const childName = activeChildBot?.name ?? t("Unknown bot");
  const usageTokens = childThread ? delegationUsageTokens(delegation, childActivities) : null;
  const canCancel = !TERMINAL_STATES.has(delegation.state) && environmentId !== null;
  const canOpen = activeChildBot !== null && childThread !== null && environmentId !== null;
  const outcome =
    delegation.failure?.message ??
    delegation.result?.summary ??
    (delegation.state === "failed"
      ? t("Failure details unavailable")
      : delegation.state === "completed"
        ? t("Result unavailable")
        : null);

  return (
    <article
      aria-label={t("Delegation to {name}", { name: childName })}
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
          <span aria-live="polite">{delegationStateLabel(delegation.state, t)}</span>
        </span>
      </div>
      <p className="mt-1 line-clamp-2 text-sm leading-5">{delegation.task}</p>
      <p className="mt-1 break-words text-xs text-muted-foreground">
        {formatDelegationAccess(delegation.access, t)}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        <DelegationElapsed delegation={delegation} />
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
        ) : null}
        <Button
          size="sm"
          variant="ghost-muted"
          className="min-h-11"
          aria-label={t("Open {name} chat", { name: childName })}
          disabled={!canOpen}
          onClick={() => {
            if (!canOpen) return;
            useRosterStore
              .getState()
              .recordChatPath(activeChildBot.id, `/${environmentId}/${childThread.id}`);
            void navigate({ to: "/bots/$botId", params: { botId: activeChildBot.id } });
          }}
        >
          {t("Open chat")}
        </Button>
      </div>
    </article>
  );
}
