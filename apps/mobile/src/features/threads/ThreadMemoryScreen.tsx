import {
  DURABLE_FACT_DELETE_CONFIRM,
  type DurableFactIntent,
  type DurableMemoryExportScope,
  type DurableMemoryFact,
  describeDurableFactFailure,
  durableFactMutation,
} from "@akeru/client-runtime/durable-memory";
import { squashAtomCommandFailure } from "@akeru/client-runtime/state/runtime";
import type {
  AkeruMemoryDocument,
  AkeruMemoryDocumentTarget,
  EnvironmentId,
  ThreadId,
} from "@akeru/contracts";
import { useRoute, type RouteProp } from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { useMobileI18n } from "../../lib/i18n";
import { useThemeColor } from "../../lib/useThemeColor";
import { useBotNames } from "../../state/bots";
import { useThreadTitles } from "../../state/entities";
import { memoryEnvironment } from "../../state/memory";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentOperateAccess } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { DurableFactsCard } from "./DurableFactsCard";

type MemoryRouteParams = {
  readonly ThreadSettingsMemory: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  };
};

/** The server's own error text, shown as received, or null when it sent none. */
const commandFailureMessage = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error ? failure.message : null;
};

const titles: Record<AkeruMemoryDocumentTarget, string> = {
  user: "USER.md",
  memory: "MEMORY.md",
  group: "GROUP.md",
};

function MemoryEditor(props: {
  readonly document: AkeruMemoryDocument;
  readonly busy: boolean;
  readonly onSave: (
    target: AkeruMemoryDocumentTarget,
    content: string,
    expectedContent: string,
  ) => Promise<void>;
}) {
  const { t, formatNumber } = useMobileI18n();
  const [draft, setDraft] = useState(props.document.content);
  const borderColor = useThemeColor("--color-border");
  const placeholderColor = useThemeColor("--color-foreground-subtle");
  useEffect(
    () => setDraft(props.document.content),
    [props.document.content, props.document.updatedAt],
  );
  const changed = draft !== props.document.content;
  const overLimit = draft.length > props.document.charLimit;

  return (
    <View className="gap-3 rounded-2xl bg-card p-4">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="font-t3-bold text-foreground">{titles[props.document.target]}</Text>
        <Text className={overLimit ? "text-xs text-destructive" : "text-xs text-foreground-muted"}>
          {formatNumber(draft.length)} / {formatNumber(props.document.charLimit)}
        </Text>
      </View>
      <TextInput
        accessibilityLabel={t("Edit {name}", { name: titles[props.document.target] })}
        className="min-h-32 rounded-xl px-3 py-3 text-sm text-foreground"
        editable={!props.busy}
        multiline
        onChangeText={setDraft}
        placeholder={t("No memory saved yet")}
        placeholderTextColor={String(placeholderColor)}
        style={{ borderColor, borderWidth: 1, textAlignVertical: "top" }}
        value={draft}
      />
      <View className="flex-row justify-end gap-2">
        <Pressable
          accessibilityRole="button"
          className="rounded-xl px-4 py-2 active:bg-subtle"
          disabled={props.busy || !changed}
          onPress={() => setDraft(props.document.content)}
        >
          <Text className="font-t3-medium text-foreground-muted">{t("Reset")}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          className="rounded-xl bg-accent px-4 py-2 active:opacity-70 disabled:opacity-40"
          disabled={props.busy || !changed || overLimit}
          onPress={() => void props.onSave(props.document.target, draft, props.document.content)}
        >
          <Text className="font-t3-bold text-accent-foreground">{t("Save")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function ThreadMemoryScreen() {
  const route = useRoute<RouteProp<MemoryRouteParams, "ThreadSettingsMemory">>();
  const insets = useSafeAreaInsets();
  const { t } = useMobileI18n();
  const { environmentId, threadId } = route.params;
  const query = useEnvironmentQuery(
    memoryEnvironment.inspectDocuments({ environmentId, input: { threadId } }),
  );
  const replaceDocument = useAtomCommand(memoryEnvironment.replaceDocument, {
    reportFailure: false,
  });
  const clearObservations = useAtomCommand(memoryEnvironment.clearObservations, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const [durableScope, setDurableScope] = useState<DurableMemoryExportScope>("bot");
  const durableQuery = useEnvironmentQuery(
    memoryEnvironment.listFacts({
      environmentId,
      input: { threadId, target: durableScope },
    }),
  );
  const mutateFact = useAtomCommand(memoryEnvironment.mutateFact, { reportFailure: false });
  const operateAccess = useEnvironmentOperateAccess(environmentId);
  const memorySettings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId))?.memory;
  const factPolicy = useMemo(
    () =>
      // Wait for both operate access and settings, so actions never flash in and out.
      operateAccess === "pending" || !memorySettings
        ? null
        : {
            canOperate: operateAccess === "granted",
            memoryEnabled: memorySettings.enabled,
            privateBotMemory: memorySettings.privateBotMemory,
          },
    [operateAccess, memorySettings],
  );
  const durableFacts = durableQuery.data?.facts;
  const threadTitles = useThreadTitles(
    useMemo(
      () => [
        ...new Set(
          (durableFacts ?? []).flatMap((fact) =>
            fact.sourceThreadId === null ? [] : [fact.sourceThreadId],
          ),
        ),
      ],
      [durableFacts],
    ),
  );
  const botNames = useBotNames(
    useMemo(
      () => [...new Set((durableFacts ?? []).flatMap((fact) => fact.affectedBotIds))],
      [durableFacts],
    ),
  );
  const [busyFactRootId, setBusyFactRootId] = useState<string | null>(null);
  const [factEdit, setFactEdit] = useState<{ rootId: string; draft: string } | null>(null);
  const [factFailure, setFactFailure] = useState<ReturnType<
    typeof describeDurableFactFailure
  > | null>(null);
  const runFactIntent = async (fact: DurableMemoryFact, intent: DurableFactIntent) => {
    setBusyFactRootId(fact.rootId);
    setFactFailure(null);
    try {
      const result = await mutateFact({
        environmentId,
        input: { threadId, mutation: durableFactMutation(fact, intent) },
      });
      if (result._tag === "Failure") {
        const described = describeDurableFactFailure(squashAtomCommandFailure(result));
        setFactFailure(described);
        // A stale edit would overwrite the newer text, so drop it with the old revision.
        if (described.conflict) setFactEdit(null);
        return;
      }
      setFactEdit(null);
    } finally {
      setBusyFactRootId(null);
    }
  };
  const previousObservations = query.data?.conversation.current
    ? query.data.conversation.history.filter(
        (item) => item.generationCount !== query.data!.conversation.current!.generationCount,
      )
    : [];

  const save = async (
    target: AkeruMemoryDocumentTarget,
    content: string,
    expectedContent: string,
  ) => {
    if (!query.data) return;
    setBusy(true);
    const result = await replaceDocument({
      environmentId,
      input: { threadId, expectedBotId: query.data.botId, expectedContent, target, content },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      Alert.alert(
        t("Could not save memory"),
        commandFailureMessage(result) ?? t("Memory request failed."),
      );
    }
  };

  if (query.isPending && !query.data) {
    return (
      <View className="flex-1 items-center justify-center bg-sheet">
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <ScrollView
      className="flex-1 bg-sheet"
      contentContainerStyle={{ gap: 12, padding: 16, paddingBottom: insets.bottom + 20 }}
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
    >
      {query.error ? <Text className="text-sm text-destructive">{query.error}</Text> : null}
      {query.data ? (
        <>
          <MemoryEditor
            key={`${environmentId}:${threadId}:${query.data.botId}:user`}
            busy={busy}
            document={query.data.user}
            onSave={save}
          />
          <MemoryEditor
            key={`${environmentId}:${threadId}:${query.data.botId}:memory`}
            busy={busy}
            document={query.data.memory}
            onSave={save}
          />
          {query.data.group ? (
            <MemoryEditor
              key={`${environmentId}:${threadId}:${query.data.botId}:group`}
              busy={busy}
              document={query.data.group}
              onSave={save}
            />
          ) : null}
          <View className="gap-3 rounded-2xl bg-card p-4">
            <Text className="font-t3-bold text-foreground">{t("Observational memory")}</Text>
            <Text className="text-xs text-foreground-muted">
              {t(
                "Automatic summaries of this chat only. Clearing them keeps the bot, its notes, and durable facts.",
              )}
            </Text>
            <Text className="text-sm text-foreground">
              {query.data.conversation.current?.activeObservations ?? t("No observations yet.")}
            </Text>
            {previousObservations.length > 0 ? (
              <View className="gap-2 border-t border-border-subtle pt-3">
                <Text className="text-xs font-t3-bold text-foreground-muted">
                  {t("Previous observations")}
                </Text>
                {previousObservations.map((item) => (
                  <Text
                    className="text-xs text-foreground-muted"
                    key={`${item.generationCount}-${item.updatedAt}`}
                  >
                    {item.activeObservations}
                  </Text>
                ))}
              </View>
            ) : null}
            <Pressable
              accessibilityRole="button"
              className="self-start rounded-xl border border-border px-4 py-2 active:bg-subtle disabled:opacity-40"
              disabled={busy || !query.data.conversation.current}
              onPress={() =>
                Alert.alert(
                  t("Clear observational memory?"),
                  t("This removes this chat's summaries."),
                  [
                    { text: t("Cancel"), style: "cancel" },
                    {
                      text: t("Clear"),
                      style: "destructive",
                      onPress: () => {
                        setBusy(true);
                        void clearObservations({ environmentId, input: { threadId } }).then(
                          (result) => {
                            setBusy(false);
                            if (result._tag === "Failure") {
                              Alert.alert(
                                t("Could not clear memory"),
                                commandFailureMessage(result) ?? t("Memory request failed."),
                              );
                            }
                          },
                        );
                      },
                    },
                  ],
                )
              }
            >
              <Text className="font-t3-medium text-foreground">{t("Clear observations")}</Text>
            </Pressable>
          </View>
          <DurableFactsCard
            botNames={botNames}
            busyRootId={busyFactRootId}
            currentBotId={query.data.botId}
            currentThreadId={threadId}
            editing={factEdit}
            error={durableQuery.error}
            facts={durableQuery.data?.facts ?? null}
            failure={
              factFailure
                ? [t(factFailure.message), factFailure.detail].filter(Boolean).join(" ")
                : null
            }
            isPending={durableQuery.isPending}
            policy={factPolicy}
            onCancelEdit={() => setFactEdit(null)}
            onDraftChange={(draft) =>
              setFactEdit((current) => (current ? { ...current, draft } : current))
            }
            onIntent={(fact, intent) => void runFactIntent(fact, intent)}
            onRequestDelete={(fact) =>
              Alert.alert(
                t(DURABLE_FACT_DELETE_CONFIRM.title),
                t(DURABLE_FACT_DELETE_CONFIRM.message),
                [
                  { text: t(DURABLE_FACT_DELETE_CONFIRM.cancel), style: "cancel" },
                  {
                    text: t(DURABLE_FACT_DELETE_CONFIRM.confirm),
                    style: "destructive",
                    onPress: () => void runFactIntent(fact, { action: "delete" }),
                  },
                ],
              )
            }
            onScopeChange={(scope) => {
              setFactEdit(null);
              setFactFailure(null);
              setDurableScope(scope);
            }}
            onStartEdit={(fact) => setFactEdit({ rootId: fact.rootId, draft: fact.fact })}
            scope={durableScope}
            threadTitles={threadTitles}
          />
        </>
      ) : null}
    </ScrollView>
  );
}
