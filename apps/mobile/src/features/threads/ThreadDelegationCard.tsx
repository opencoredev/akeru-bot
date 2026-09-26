/**
 * One work card inside the mobile chat feed: the other bot, its task, the
 * delegation's state, and the same reverse-state actions the web card offers.
 *
 * @module features/threads/ThreadDelegationCard
 */
import type { AkeruDelegationRecord, OrchestrationBot } from "@t3tools/contracts";
import { akeruDelegationStateOf, type AkeruDelegationState } from "@t3tools/contracts";
import {
  presentDelegation,
  type DelegationAction,
} from "@t3tools/client-runtime/delegation-presentation";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { BotAvatarView, seededBlobAvatar } from "../../components/BotAvatarView";
import { useMobileI18n } from "../../lib/i18n";

function stateLabel(state: AkeruDelegationState, t: ReturnType<typeof useMobileI18n>["t"]): string {
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

const STATE_DOT_CLASS: Record<AkeruDelegationState, string> = {
  queued: "bg-muted-foreground/50",
  running: "bg-info",
  blocked: "bg-warning",
  failed: "bg-destructive",
  canceled: "bg-muted-foreground/60",
  completed: "bg-success",
};

/** Elapsed time stamps once the card mounts; live cards do not repaint per second. */
function delegationElapsed(delegation: AkeruDelegationRecord): string | null {
  const phase = delegation.phase;
  const startedAt = Date.parse(
    phase._tag === "Queued" || phase.startedAt === null ? delegation.createdAt : phase.startedAt,
  );
  const endedAt =
    phase._tag === "Failed" || phase._tag === "Canceled" || phase._tag === "Completed"
      ? Date.parse(phase.completedAt)
      : Date.now();
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt) return null;
  return formatDuration(endedAt - startedAt);
}

type Translate = ReturnType<typeof useMobileI18n>["t"];

function actionCopy(action: DelegationAction, t: Translate, name: string) {
  switch (action) {
    case "keep":
      return {
        label: t("Let it finish"),
        accessibilityLabel: t("Let {name} finish the work", { name }),
      };
    case "cancel":
      return { label: t("Cancel"), accessibilityLabel: t("Cancel delegation to {name}", { name }) };
    case "retry":
      return { label: t("Try again"), accessibilityLabel: t("Ask {name} to try again", { name }) };
  }
}

/**
 * `actions` comes from the shared `delegationActions`, judged against the whole
 * chat. `onAction` runs one; every button stays disabled until it settles.
 */
export function ThreadDelegationCard(props: {
  readonly delegation: AkeruDelegationRecord;
  readonly childBot: OrchestrationBot | null;
  readonly parentBot: OrchestrationBot | null;
  readonly actions?: ReadonlyArray<DelegationAction>;
  readonly onAction?: (action: DelegationAction) => Promise<void>;
}) {
  const { t } = useMobileI18n();
  const [pending, setPending] = useState<DelegationAction | null>(null);
  const onAction = props.onAction;
  const actions = onAction ? (props.actions ?? []) : [];
  const { delegation } = props;
  const presentation = presentDelegation(delegation);
  const state = akeruDelegationStateOf(delegation.phase);
  const childName = props.childBot?.name ?? t("Unknown bot");
  const parentName = props.parentBot?.name ?? t("Unknown bot");
  const elapsed = delegationElapsed(delegation);
  const outcome = presentation.outcome
    ? presentation.outcome.text ||
      (presentation.outcome.kind === "failure"
        ? t("Failure details unavailable")
        : t("Result unavailable"))
    : null;

  return (
    <View
      className="mx-4 mb-3 gap-1 border-l-2 border-border pl-3"
      accessibilityLabel={t("Delegation to {name}", { name: childName })}
    >
      <View className="flex-row items-center gap-2">
        <BotAvatarView
          avatar={props.childBot?.avatar ?? seededBlobAvatar(delegation.childBotId)}
          size={24}
        />
        <Text className="min-w-0 flex-1 font-t3-medium text-sm" numberOfLines={1}>
          {childName}
        </Text>
        <View className="flex-row shrink-0 items-center gap-1.5">
          <View className={`size-1.5 rounded-full ${STATE_DOT_CLASS[state]}`} />
          <Text className="text-xs text-muted-foreground" accessibilityLiveRegion="polite">
            {stateLabel(state, t)}
          </Text>
        </View>
      </View>
      <Text className="text-sm" numberOfLines={2}>
        {delegation.task}
      </Text>
      {elapsed !== null ? (
        <Text className="text-xs tabular-nums text-muted-foreground">{elapsed}</Text>
      ) : null}
      {outcome !== null ? (
        <Text
          className={
            presentation.outcome?.kind === "failure"
              ? "text-sm text-destructive"
              : "text-sm text-muted-foreground"
          }
          numberOfLines={4}
        >
          {outcome}
        </Text>
      ) : null}
      {presentation.delivery ? (
        <Text className="text-xs text-muted-foreground">
          {presentation.delivery === "pending"
            ? t("Result waiting for the next reply")
            : t("Result delivered to {name}", { name: parentName })}
        </Text>
      ) : null}
      {onAction && actions.length > 0 ? (
        <View className="flex-row gap-1">
          {actions.map((action) => {
            const copy = actionCopy(action, t, childName);
            return (
              <Pressable
                key={action}
                accessibilityRole="button"
                accessibilityLabel={copy.accessibilityLabel}
                accessibilityState={{ disabled: pending !== null, busy: pending === action }}
                className="min-h-11 justify-center rounded-lg px-2 active:bg-subtle disabled:opacity-40"
                disabled={pending !== null}
                onPress={() => {
                  setPending(action);
                  void onAction(action).finally(() => setPending(null));
                }}
              >
                <Text className="font-t3-medium text-xs text-foreground-muted">{copy.label}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
