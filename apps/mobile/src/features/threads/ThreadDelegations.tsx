/**
 * Work a chat's bot sent to other bots, shown above the composer.
 *
 * The parent bot replies first; these rows keep updating as each child finishes and
 * say whether the parent has received the result yet.
 *
 * @module features/threads/ThreadDelegations
 */
import { useAtomValue } from "@effect/atom-react";
import {
  presentDelegation,
  threadDelegations,
  type DelegationPresentation,
} from "@t3tools/client-runtime/delegation-presentation";
import type { BotId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useMobileI18n } from "../../lib/i18n";
import { useBotNames } from "../../state/bots";
import { environmentSnapshotAtom } from "../../state/shell";

interface DelegationRow {
  readonly delegationId: string;
  readonly childBotId: BotId;
  readonly parentBotId: BotId;
  readonly task: string;
  readonly presentation: DelegationPresentation;
}

interface ThreadDelegationRows {
  readonly rows: ReadonlyArray<DelegationRow>;
  readonly waitingOnChildren: boolean;
}

// Keyed by environment and thread. The value is a JSON string so the atom only
// notifies when this chat's delegations change, not on every snapshot update.
const threadDelegationsAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = key.split("\n") as [EnvironmentId, ThreadId];
  return Atom.make((get) => {
    const snapshot = get(environmentSnapshotAtom(environmentId));
    const { delegations, waitingOnChildren } = threadDelegations(
      snapshot?.delegations ?? [],
      threadId,
    );
    const value: ThreadDelegationRows = {
      rows: delegations.map((delegation) => ({
        delegationId: delegation.delegationId,
        childBotId: delegation.childBotId,
        parentBotId: delegation.parentBotId,
        task: delegation.task,
        presentation: presentDelegation(delegation),
      })),
      waitingOnChildren,
    };
    return JSON.stringify(value);
  }).pipe(Atom.withLabel(`mobile-thread-delegations:${key}`));
});

function stateLabel(
  state: DelegationPresentation["state"],
  t: ReturnType<typeof useMobileI18n>["t"],
): string {
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

export function ThreadDelegations(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { t } = useMobileI18n();
  const json = useAtomValue(threadDelegationsAtom(`${props.environmentId}\n${props.threadId}`));
  const { rows, waitingOnChildren } = useMemo(
    () => JSON.parse(json) as ThreadDelegationRows,
    [json],
  );
  const names = useBotNames(rows.flatMap((row) => [row.childBotId, row.parentBotId]));
  if (rows.length === 0) return null;

  return (
    <View className="mx-4 mb-3 gap-2" accessibilityLabel={t("Delegated work")}>
      {rows.map(({ delegationId, childBotId, parentBotId, task, presentation }) => {
        const name = names.get(childBotId) ?? t("Unknown bot");
        const parentName = names.get(parentBotId) ?? t("Unknown bot");
        return (
          <View
            key={delegationId}
            className="gap-1 border-l-2 border-border pl-3"
            accessibilityLabel={t("Delegation to {name}", { name })}
          >
            <View className="flex-row items-center gap-2">
              <Text className="flex-1 text-sm font-t3-medium" numberOfLines={1}>
                {name}
              </Text>
              <Text className="text-xs text-muted-foreground" accessibilityLiveRegion="polite">
                {stateLabel(presentation.state, t)}
              </Text>
            </View>
            <Text className="text-sm" numberOfLines={2}>
              {task}
            </Text>
            {presentation.outcome?.text ? (
              <Text
                className={
                  presentation.outcome.kind === "failure"
                    ? "text-sm text-destructive"
                    : "text-sm text-muted-foreground"
                }
                numberOfLines={4}
              >
                {presentation.outcome.text}
              </Text>
            ) : null}
            {presentation.delivery ? (
              <Text className="text-xs text-muted-foreground">
                {presentation.delivery === "pending"
                  ? t("Result waiting for the next reply")
                  : t("Result delivered to {name}", { name: parentName })}
              </Text>
            ) : null}
          </View>
        );
      })}
      {waitingOnChildren ? (
        <Text className="text-xs text-muted-foreground">{t("Waiting on delegated work")}</Text>
      ) : null}
    </View>
  );
}
