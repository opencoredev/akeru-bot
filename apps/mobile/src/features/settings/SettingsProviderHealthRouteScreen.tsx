import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import type { BotInboxItem, EnvironmentId } from "@t3tools/contracts";
import { Platform, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { botInboxEnvironment } from "../../state/botInbox";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { canResolveInboxItem, settingsInboxView } from "./botInbox.logic";
import { SettingsSection } from "./components/SettingsSection";
import { ProviderConnections } from "./ProviderConnections";

export type SettingsProviderHealthParams = {
  readonly environmentId: EnvironmentId;
  readonly target: "local-execution" | "bot-inbox" | "providers";
} & Record<string, unknown>;

function Field(props: { readonly label: string; readonly value: string }) {
  return (
    <View className="gap-1">
      <Text className="text-xs font-t3-medium text-foreground-muted">{props.label}</Text>
      <Text className="text-sm text-foreground">{props.value}</Text>
    </View>
  );
}

function BotInbox({
  environmentId,
  items,
}: {
  readonly environmentId: EnvironmentId;
  readonly items: ReadonlyArray<BotInboxItem>;
}) {
  const resolveIncident = useAtomCommand(botInboxEnvironment.resolve);
  return (
    <SettingsSection title="Error inbox" card>
      {items.length === 0 ? (
        <Text className="p-4 text-sm text-foreground-muted">No open items.</Text>
      ) : (
        items.map((item, index) => (
          <View
            key={item.id}
            className={index === 0 ? "gap-2 p-4" : "gap-2 border-t border-border-subtle p-4"}
          >
            <Text className="text-base font-t3-medium text-foreground">{item.botName}</Text>
            <Field label="Bot work or routine" value={item.taskOrRoutine} />
            <Field label="Last failure" value={item.lastFailure} />
            <Field label="Next action" value={item.nextAction} />
            {canResolveInboxItem(item) ? (
              <Pressable
                accessibilityRole="button"
                className="self-start rounded-[12px] bg-subtle px-3 py-2"
                onPress={() => {
                  void resolveIncident({ environmentId, input: { id: item.id } });
                }}
              >
                <Text className="text-sm font-t3-medium text-foreground">Resolve</Text>
              </Pressable>
            ) : null}
          </View>
        ))
      )}
    </SettingsSection>
  );
}

function LocalExecution({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const mode = settings?.defaultThreadEnvMode ?? "local";
  return (
    <SettingsSection title="Local execution" card>
      <View className="gap-3 p-4">
        <Text className="text-sm text-foreground-muted">
          Pick the default workspace mode for new threads on this environment.
        </Text>
        <View className="flex-row gap-2">
          {(["local", "worktree"] as const).map((value) => (
            <Pressable
              key={value}
              accessibilityRole="button"
              accessibilityState={{ selected: mode === value }}
              className={
                mode === value
                  ? "flex-1 rounded-[14px] bg-foreground px-4 py-3"
                  : "flex-1 rounded-[14px] bg-subtle px-4 py-3"
              }
              onPress={() => {
                void updateSettings({
                  environmentId,
                  input: { patch: { defaultThreadEnvMode: value } },
                });
              }}
            >
              <Text
                className={
                  mode === value
                    ? "text-center text-sm font-t3-medium text-background"
                    : "text-center text-sm font-t3-medium text-foreground"
                }
              >
                {value === "local" ? "Local" : "New worktree"}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    </SettingsSection>
  );
}

export function SettingsProviderHealthRouteScreen({
  route,
}: StaticScreenProps<SettingsProviderHealthParams>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const query = useEnvironmentQuery(
    route.params.target !== "bot-inbox"
      ? null
      : botInboxEnvironment.list({
          environmentId: route.params.environmentId,
          input: {},
        }),
  );
  const inboxView =
    route.params.target === "bot-inbox"
      ? settingsInboxView({ error: query.error, data: query.data })
      : null;
  const section =
    route.params.target === "local-execution" ? (
      <LocalExecution environmentId={route.params.environmentId} />
    ) : inboxView?.kind === "ready" ? (
      <BotInbox environmentId={route.params.environmentId} items={inboxView.items} />
    ) : null;

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <NativeStackScreenOptions options={{ headerShown: false }} />
      ) : null}
      {Platform.OS === "android" ? (
        <AndroidScreenHeader title="Settings" onBack={() => navigation.goBack()} />
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          route.params.target === "bot-inbox" ? (
            <RefreshControl refreshing={query.isPending} onRefresh={query.refresh} />
          ) : undefined
        }
      >
        {route.params.target === "providers" ? (
          <ProviderConnections
            key={route.params.environmentId}
            environmentId={route.params.environmentId}
          />
        ) : route.params.target === "local-execution" ? (
          section
        ) : inboxView?.kind === "error" ? (
          <Text className="py-16 text-center text-sm text-danger">{inboxView.message}</Text>
        ) : inboxView?.kind === "loading" ? (
          <Text className="py-16 text-center text-sm text-foreground-muted">
            Loading bot inbox…
          </Text>
        ) : (
          section
        )}
      </ScrollView>
    </View>
  );
}
