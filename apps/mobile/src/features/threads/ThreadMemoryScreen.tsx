import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  AkeruMemoryDocument,
  AkeruMemoryDocumentTarget,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { useRoute, type RouteProp } from "@react-navigation/native";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";
import { memoryEnvironment } from "../../state/memory";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

type MemoryRouteParams = {
  readonly ThreadSettingsMemory: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  };
};

const commandFailureMessage = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error ? failure.message : "Memory request failed.";
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
          {draft.length.toLocaleString()} / {props.document.charLimit.toLocaleString()}
        </Text>
      </View>
      <TextInput
        accessibilityLabel={`Edit ${titles[props.document.target]}`}
        className="min-h-32 rounded-xl px-3 py-3 text-sm text-foreground"
        editable={!props.busy}
        multiline
        onChangeText={setDraft}
        placeholder="No memory saved yet"
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
          <Text className="font-t3-medium text-foreground-muted">Reset</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          className="rounded-xl bg-accent px-4 py-2 active:opacity-70 disabled:opacity-40"
          disabled={props.busy || !changed || overLimit}
          onPress={() => void props.onSave(props.document.target, draft, props.document.content)}
        >
          <Text className="font-t3-bold text-accent-foreground">Save</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function ThreadMemoryScreen() {
  const route = useRoute<RouteProp<MemoryRouteParams, "ThreadSettingsMemory">>();
  const insets = useSafeAreaInsets();
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
      Alert.alert("Could not save memory", commandFailureMessage(result));
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
            <Text className="font-t3-bold text-foreground">Observational memory</Text>
            <Text className="text-xs text-foreground-muted">
              Automatic summaries of this chat, kept separate from the Markdown files.
            </Text>
            <Text className="text-sm text-foreground">
              {query.data.conversation.current?.activeObservations ?? "No observations yet."}
            </Text>
            {previousObservations.length > 0 ? (
              <View className="gap-2 border-t border-border-subtle pt-3">
                <Text className="text-xs font-t3-bold text-foreground-muted">
                  Previous observations
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
                Alert.alert("Clear observational memory?", "This removes this chat's summaries.", [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Clear",
                    style: "destructive",
                    onPress: () => {
                      setBusy(true);
                      void clearObservations({ environmentId, input: { threadId } }).then(
                        (result) => {
                          setBusy(false);
                          if (result._tag === "Failure") {
                            Alert.alert("Could not clear memory", commandFailureMessage(result));
                          }
                        },
                      );
                    },
                  },
                ])
              }
            >
              <Text className="font-t3-medium text-foreground">Clear observations</Text>
            </Pressable>
          </View>
        </>
      ) : null}
    </ScrollView>
  );
}
