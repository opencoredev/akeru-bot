import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import { selectOpenBotInboxItems } from "@t3tools/client-runtime/bot-inbox";
import type { EnvironmentId, SubscriptionAuthStatuses } from "@t3tools/contracts";
import { Platform, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsSection } from "./components/SettingsSection";

export type SettingsProviderHealthParams = (
  | { readonly environmentId: EnvironmentId; readonly target: "local-execution" }
  | { readonly environmentId?: EnvironmentId; readonly target: "bot-inbox" }
) &
  Record<string, unknown>;

function Field(props: { readonly label: string; readonly value: string }) {
  return (
    <View className="gap-1">
      <Text className="text-xs font-t3-medium text-foreground-muted">{props.label}</Text>
      <Text className="text-sm text-foreground">{props.value}</Text>
    </View>
  );
}

function BotInbox({
  data,
  title = "Error inbox",
}: {
  readonly data: SubscriptionAuthStatuses;
  readonly title?: string;
}) {
  const openItems = selectOpenBotInboxItems(data.inbox);
  return (
    <SettingsSection title={title} card>
      {openItems.length === 0 ? (
        <Text className="p-4 text-sm text-foreground-muted">No open items.</Text>
      ) : (
        openItems.map((item, index) => (
          <View
            key={item.id}
            className={index === 0 ? "gap-2 p-4" : "gap-2 border-t border-border-subtle p-4"}
          >
            <Text className="text-base font-t3-medium text-foreground">{item.botName}</Text>
            <Field label="Task or routine" value={item.taskOrRoutine} />
            <Field label="Last failure" value={item.lastFailure} />
            <Field label="Next action" value={item.nextAction} />
          </View>
        ))
      )}
    </SettingsSection>
  );
}

function EnvironmentBotInbox({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.subscriptionAuth({ environmentId, input: {} }),
  );
  if (query.error) {
    return (
      <SettingsSection title={label} card>
        <Text className="p-4 text-sm text-danger">{query.error}</Text>
      </SettingsSection>
    );
  }
  if (!query.data) {
    return (
      <SettingsSection title={label} card>
        <Text className="p-4 text-sm text-foreground-muted">Loading errors…</Text>
      </SettingsSection>
    );
  }
  return <BotInbox data={query.data} title={label} />;
}

function AllEnvironmentBotInboxes() {
  const { savedConnectionsById } = useSavedRemoteConnections();
  const connections = Object.values(savedConnectionsById);
  if (connections.length === 0) {
    return (
      <SettingsSection title="Error inbox" card>
        <Text className="p-4 text-sm text-foreground-muted">No environments connected.</Text>
      </SettingsSection>
    );
  }
  return connections.map((connection) => (
    <EnvironmentBotInbox
      key={connection.environmentId}
      environmentId={connection.environmentId}
      label={connection.environmentLabel}
    />
  ));
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
  const inboxEnvironmentId =
    route.params.target === "bot-inbox" ? route.params.environmentId : undefined;
  const query = useEnvironmentQuery(
    route.params.target === "local-execution" || inboxEnvironmentId === undefined
      ? null
      : serverEnvironment.subscriptionAuth({
          environmentId: inboxEnvironmentId,
          input: {},
        }),
  );
  const section =
    route.params.target === "local-execution" ? (
      <LocalExecution environmentId={route.params.environmentId} />
    ) : inboxEnvironmentId === undefined ? (
      <AllEnvironmentBotInboxes />
    ) : query.data ? (
      <BotInbox data={query.data} />
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
        refreshControl={
          inboxEnvironmentId === undefined ? undefined : (
            <RefreshControl refreshing={query.isPending} onRefresh={query.refresh} />
          )
        }
      >
        {route.params.target === "local-execution" || inboxEnvironmentId === undefined ? (
          section
        ) : query.error ? (
          <Text className="py-16 text-center text-sm text-danger">{query.error}</Text>
        ) : query.data === null ? (
          <Text className="py-16 text-center text-sm text-foreground-muted">
            Loading provider health…
          </Text>
        ) : (
          section
        )}
      </ScrollView>
    </View>
  );
}
