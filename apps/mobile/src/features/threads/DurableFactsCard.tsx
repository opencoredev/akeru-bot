/**
 * Durable facts for one memory scope, with the actions each fact's state allows.
 *
 * Presentation only: the memory screen owns the query, the chosen scope, the edit draft, and
 * the delete confirmation, so every state renders without a connection.
 *
 * @module features/threads/DurableFactsCard
 */
import {
  DURABLE_MEMORY_APPROVAL_LABELS,
  DURABLE_MEMORY_DELETION_LABELS,
  DURABLE_MEMORY_INSPECT_SCOPES,
  DURABLE_MEMORY_SCOPE_LABELS,
  type DurableFactIntent,
  type DurableFactPolicy,
  type DurableMemoryExportScope,
  type DurableMemoryFact,
  canSaveDurableFactEdit,
  durableFactActions,
  durableFactBotsLabel,
  durableFactMoveScopes,
  durableFactReadOnlyReason,
  durableFactSourceLabel,
} from "@t3tools/client-runtime/durable-memory";
import type { MessageKey } from "@t3tools/client-runtime/i18n";
import { Pressable, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useMobileI18n } from "../../lib/i18n";

type MobileI18n = ReturnType<typeof useMobileI18n>;

const TIME_FORMAT: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" };

function formatTime(value: string, i18n: MobileI18n) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : i18n.formatDate(date, TIME_FORMAT);
}

function factStatus(fact: DurableMemoryFact, i18n: MobileI18n) {
  return [
    i18n.t(DURABLE_MEMORY_APPROVAL_LABELS[fact.approvalState]),
    fact.deletionState === "active"
      ? null
      : i18n.t(DURABLE_MEMORY_DELETION_LABELS[fact.deletionState]),
    fact.pinned ? i18n.t("Pinned") : null,
  ]
    .filter((part) => part !== null)
    .join(i18n.t(", "));
}

const SIMPLE_ACTION_LABELS: Readonly<
  Record<"pin" | "unpin" | "approve" | "reject" | "forget", MessageKey>
> = {
  pin: "Pin",
  unpin: "Unpin",
  approve: "Approve",
  reject: "Reject",
  forget: "Forget",
};

function ActionButton(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly destructive?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      className="rounded-xl border border-border px-3 py-1.5 active:bg-subtle disabled:opacity-40"
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <Text
        className={
          props.destructive
            ? "text-xs font-t3-medium text-destructive"
            : "text-xs font-t3-medium text-foreground"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function factActionButtons(
  fact: DurableMemoryFact,
  props: {
    readonly busy: boolean;
    readonly policy: DurableFactPolicy;
    readonly onIntent: (fact: DurableMemoryFact, intent: DurableFactIntent) => void;
    readonly onStartEdit: (fact: DurableMemoryFact) => void;
    readonly onRequestDelete: (fact: DurableMemoryFact) => void;
  },
  t: MobileI18n["t"],
) {
  return durableFactActions(fact, props.policy).flatMap((action) => {
    switch (action) {
      case "edit":
        return [
          <ActionButton
            key="edit"
            label={t("Edit")}
            disabled={props.busy}
            onPress={() => props.onStartEdit(fact)}
          />,
        ];
      case "move":
        return durableFactMoveScopes(fact, props.policy).map((option) => (
          <ActionButton
            key={`move:${option.scope}`}
            label={t(option.label)}
            disabled={props.busy}
            onPress={() => props.onIntent(fact, { action: "move", scope: option.scope })}
          />
        ));
      case "delete":
        return [
          <ActionButton
            key="delete"
            label={t("Delete")}
            destructive
            disabled={props.busy}
            onPress={() => props.onRequestDelete(fact)}
          />,
        ];
      default:
        return [
          <ActionButton
            key={action}
            label={t(SIMPLE_ACTION_LABELS[action])}
            disabled={props.busy}
            onPress={() => props.onIntent(fact, { action })}
          />,
        ];
    }
  });
}

export function DurableFactsCard(props: {
  readonly scope: DurableMemoryExportScope;
  readonly onScopeChange: (scope: DurableMemoryExportScope) => void;
  readonly facts: ReadonlyArray<DurableMemoryFact> | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly currentThreadId: string;
  readonly currentBotId: string | null;
  /** Chat titles and bot names by id, so provenance never shows a raw id. */
  readonly threadTitles: ReadonlyMap<string, string>;
  readonly botNames: ReadonlyMap<string, string>;
  /**
   * What this connection may change. `null` while operate access is still resolving: actions
   * stay hidden and no read-only reason shows yet.
   */
  readonly policy: DurableFactPolicy | null;
  /** Plain message from the last failed fact change. */
  readonly failure: string | null;
  readonly busyRootId: string | null;
  readonly editing: { readonly rootId: string; readonly draft: string } | null;
  readonly onIntent: (fact: DurableMemoryFact, intent: DurableFactIntent) => void;
  readonly onStartEdit: (fact: DurableMemoryFact) => void;
  readonly onDraftChange: (draft: string) => void;
  readonly onCancelEdit: () => void;
  /** Asks the user to confirm; the card never deletes on its own. */
  readonly onRequestDelete: (fact: DurableMemoryFact) => void;
}) {
  const i18n = useMobileI18n();
  const { t } = i18n;
  const busy = props.busyRootId !== null;
  const readOnlyReason = props.policy ? durableFactReadOnlyReason(props.policy) : null;
  return (
    <View className="gap-3 rounded-2xl bg-card p-4">
      <Text className="font-t3-bold text-foreground">{t("Durable facts")}</Text>
      <Text className="text-xs text-foreground-muted">
        {t("Facts kept beyond this chat. Clearing observations does not remove them.")}
      </Text>
      <View accessibilityRole="tablist" className="flex-row flex-wrap gap-2">
        {DURABLE_MEMORY_INSPECT_SCOPES.map((option) => {
          const selected = option.scope === props.scope;
          return (
            <Pressable
              key={option.scope}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              className={
                selected
                  ? "rounded-xl bg-accent px-3 py-1.5"
                  : "rounded-xl border border-border px-3 py-1.5 active:bg-subtle"
              }
              onPress={() => props.onScopeChange(option.scope)}
            >
              <Text
                className={
                  selected
                    ? "text-xs font-t3-bold text-accent-foreground"
                    : "text-xs font-t3-medium text-foreground"
                }
              >
                {t(option.label)}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {props.error ? (
        <Text className="text-sm text-destructive">{t("Durable facts unavailable.")}</Text>
      ) : props.isPending && !props.facts ? (
        <Text className="text-sm text-foreground-muted">{t("Loading durable facts…")}</Text>
      ) : props.facts && props.facts.length === 0 ? (
        <Text className="text-sm text-foreground-muted">
          {t("No durable facts in this scope yet.")}
        </Text>
      ) : null}
      {props.failure ? (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {props.failure}
        </Text>
      ) : null}
      {props.error
        ? null
        : props.facts?.map((fact) => {
            // An open draft closes if the policy stops allowing edits.
            const editing =
              props.editing?.rootId === fact.rootId &&
              props.policy &&
              durableFactActions(fact, props.policy).includes("edit")
                ? props.editing
                : null;
            const source = durableFactSourceLabel(
              fact,
              { currentThreadId: props.currentThreadId, threadTitles: props.threadTitles },
              i18n,
            );
            const bots =
              durableFactBotsLabel(
                fact,
                { currentBotId: props.currentBotId, botNames: props.botNames },
                i18n,
              ) ?? t("none");
            const created = formatTime(fact.createdAt, i18n);
            const updated = formatTime(fact.updatedAt, i18n);
            return (
              <View key={fact.rootId} className="gap-1 border-t border-border-subtle pt-3">
                {editing ? (
                  <View className="gap-2">
                    <TextInput
                      accessibilityLabel={t("Edit fact")}
                      className="min-h-16 rounded-xl border border-border px-3 py-2 text-sm text-foreground"
                      editable={!busy}
                      multiline
                      onChangeText={props.onDraftChange}
                      value={editing.draft}
                    />
                    <View className="flex-row gap-2">
                      <ActionButton
                        label={t("Save")}
                        disabled={busy || !canSaveDurableFactEdit(fact, editing.draft)}
                        onPress={() =>
                          props.onIntent(fact, { action: "edit", fact: editing.draft })
                        }
                      />
                      <ActionButton
                        label={t("Cancel")}
                        disabled={busy}
                        onPress={props.onCancelEdit}
                      />
                    </View>
                  </View>
                ) : (
                  <Text
                    className={
                      fact.deletionState === "active"
                        ? "text-sm text-foreground"
                        : "text-sm text-foreground-muted"
                    }
                  >
                    {fact.fact}
                  </Text>
                )}
                {fact.supersededFact ? (
                  <Text className="text-xs text-foreground-muted">
                    {t("Replaced: {fact}", { fact: fact.supersededFact })}
                  </Text>
                ) : null}
                <Text className="text-xs text-foreground-muted">
                  {t(DURABLE_MEMORY_SCOPE_LABELS[fact.scope])} · {factStatus(fact, i18n)}
                </Text>
                <Text className="text-xs text-foreground-muted">
                  {source === null
                    ? t("Bots: {bots}", { bots })
                    : t("From {source} · Bots: {bots}", { source, bots })}
                </Text>
                <Text className="text-xs text-foreground-muted">
                  {t("Created {created} · Updated {updated}", { created, updated })}
                </Text>
                {props.busyRootId === fact.rootId ? (
                  <Text accessibilityLiveRegion="polite" className="text-xs text-foreground-muted">
                    {t("Saving…")}
                  </Text>
                ) : null}
                {editing || !props.policy ? null : (
                  <View className="flex-row flex-wrap gap-2 pt-1">
                    {factActionButtons(
                      fact,
                      {
                        busy,
                        policy: props.policy,
                        onIntent: props.onIntent,
                        onStartEdit: props.onStartEdit,
                        onRequestDelete: props.onRequestDelete,
                      },
                      t,
                    )}
                  </View>
                )}
              </View>
            );
          })}
      {readOnlyReason && !props.error ? (
        <Text className="text-xs text-foreground-muted">{t(readOnlyReason)}</Text>
      ) : null}
      <Text className="text-xs text-foreground-muted">
        {t("Export or import durable facts from the desktop or web app.")}
      </Text>
    </View>
  );
}
