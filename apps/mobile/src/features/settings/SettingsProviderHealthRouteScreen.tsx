import { useMobileI18n } from "../../lib/i18n";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import { botInboxItemCopy, botInboxRowAction } from "@t3tools/client-runtime/bot-inbox";
import {
  describeDurableFactFailure,
  memoryApprovalMutation,
  type MemoryApprovalIntent,
} from "@t3tools/client-runtime/durable-memory";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { BotInboxItem, EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { Platform, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { botInboxEnvironment } from "../../state/botInbox";
import { memoryEnvironment } from "../../state/memory";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { settingsInboxView } from "./botInbox.logic";
import { SettingsSection } from "./components/SettingsSection";
import { ImageGenerationSummary } from "./ImageGenerationSummary";
import { ProviderConnections } from "./ProviderConnections";
import type { MobileSettingsHealthTarget } from "./settingsDeepLink";

export type SettingsProviderHealthParams = {
  readonly environmentId: EnvironmentId;
  readonly target: MobileSettingsHealthTarget;
} & Record<string, unknown>;

function Field(props: { readonly label: string; readonly value: string }) {
  return (
    <View className="gap-1">
      <Text className="text-xs font-t3-medium text-foreground-muted">{props.label}</Text>
      <Text className="text-sm text-foreground">{props.value}</Text>
    </View>
  );
}

function BotInboxRow({
  environmentId,
  item,
  first,
  onDecided,
}: {
  readonly environmentId: EnvironmentId;
  readonly item: BotInboxItem;
  readonly first: boolean;
  readonly onDecided: () => void;
}) {
  const { t } = useMobileI18n();
  const navigation = useNavigation();
  const resolveIncident = useAtomCommand(botInboxEnvironment.resolve, { reportFailure: false });
  const mutateFact = useAtomCommand(memoryEnvironment.mutateFact, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const action = botInboxRowAction(item);
  const copy = botInboxItemCopy(item, t);
  const run = async (task: () => Promise<string | null>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setError(await task());
    } finally {
      setBusy(false);
    }
  };
  const decideMemory = (intent: MemoryApprovalIntent) =>
    run(async () => {
      const approval = item.memoryApproval;
      if (!approval) return null;
      const result = await mutateFact({
        environmentId,
        input: {
          threadId: approval.sourceThreadId,
          mutation: memoryApprovalMutation(approval, intent),
        },
      });
      if (result._tag === "Failure") {
        return t(describeDurableFactFailure(squashAtomCommandFailure(result)).message);
      }
      // The server closes the inbox item when it records the decision.
      onDecided();
      return null;
    });
  const resolve = () =>
    run(async () => {
      const result = await resolveIncident({ environmentId, input: { id: item.id } });
      return result._tag === "Failure" ? t("Could not resolve this item") : null;
    });

  return (
    <View className={first ? "gap-2 p-4" : "gap-2 border-t border-border-subtle p-4"}>
      <Text className="text-base font-t3-medium text-foreground">{item.botName}</Text>
      <Field label={t("Bot work or routine")} value={`${item.taskOrRoutine} · ${copy.kind}`} />
      <Field
        label={item.memoryApproval ? t("Memory to save") : t("Last failure")}
        value={copy.detail}
      />
      {copy.sensitive ? (
        <Text className="text-xs text-foreground-muted">{copy.sensitive}</Text>
      ) : null}
      <Field label={t("Next action")} value={copy.nextAction} />
      {action === "memory-approval" ? (
        <View className="flex-row gap-2">
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            className="rounded-[12px] bg-subtle px-3 py-2"
            onPress={() => void decideMemory({ action: "reject" })}
          >
            <Text className="text-sm font-t3-medium text-foreground">{t("Reject")}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            className="rounded-[12px] bg-foreground px-3 py-2"
            onPress={() => void decideMemory({ action: "approve" })}
          >
            <Text className="text-sm font-t3-medium text-background">{t("Approve")}</Text>
          </Pressable>
        </View>
      ) : (
        <>
          {action === "plugins" ? (
            <Text className="text-sm text-foreground-muted">
              {t("Fix this in Plugins on the desktop or web app.")}
            </Text>
          ) : null}
          <View className="flex-row flex-wrap gap-2">
            {action === "providers" ? (
              <Pressable
                accessibilityRole="button"
                className="rounded-[12px] bg-subtle px-3 py-2"
                onPress={() =>
                  navigation.dispatch(
                    StackActions.push("SettingsProviderHealth", {
                      environmentId,
                      target: "providers",
                    }),
                  )
                }
              >
                <Text className="text-sm font-t3-medium text-foreground">
                  {t("Open Providers")}
                </Text>
              </Pressable>
            ) : null}
            {/* Repair rows resolve too: mobile cannot always reach the repair screen. */}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              className="rounded-[12px] bg-subtle px-3 py-2"
              onPress={() => void resolve()}
            >
              <Text className="text-sm font-t3-medium text-foreground">
                {busy ? t("Resolving…") : t("Resolve")}
              </Text>
            </Pressable>
          </View>
        </>
      )}
      {error ? <Text className="text-sm text-danger">{error}</Text> : null}
    </View>
  );
}

function BotInbox({
  environmentId,
  items,
  onDecided,
}: {
  readonly environmentId: EnvironmentId;
  readonly items: ReadonlyArray<BotInboxItem>;
  readonly onDecided: () => void;
}) {
  const { t } = useMobileI18n();
  return (
    <SettingsSection title={t("Bot inbox")} card>
      {items.length === 0 ? (
        <View className="gap-1 p-4">
          <Text className="text-sm font-t3-medium text-foreground">{t("Nothing open")}</Text>
          <Text className="text-sm text-foreground-muted">
            {t("Bot failures and memory approvals appear here.")}
          </Text>
        </View>
      ) : (
        items.map((item, index) => (
          <BotInboxRow
            key={item.id}
            environmentId={environmentId}
            item={item}
            first={index === 0}
            onDecided={onDecided}
          />
        ))
      )}
    </SettingsSection>
  );
}

function LocalExecution({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { t } = useMobileI18n();
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const mode = settings?.defaultThreadEnvMode ?? "local";
  return (
    <SettingsSection title={t("Local execution")} card>
      <View className="gap-3 p-4">
        <Text className="text-sm text-foreground-muted">
          {t("Pick the default workspace mode for new chats on this environment.")}
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
                {value === "local" ? t("Local") : t("New worktree")}
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
  const { t } = useMobileI18n();
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
      <BotInbox
        environmentId={route.params.environmentId}
        items={inboxView.items}
        onDecided={query.refresh}
      />
    ) : null;

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <NativeStackScreenOptions options={{ headerShown: false }} />
      ) : null}
      {Platform.OS === "android" ? (
        <AndroidScreenHeader title={t("Settings")} onBack={() => navigation.goBack()} />
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
        ) : route.params.target === "image-generation" ? (
          <ImageGenerationSummary
            key={route.params.environmentId}
            environmentId={route.params.environmentId}
          />
        ) : route.params.target === "local-execution" ? (
          section
        ) : inboxView?.kind === "error" ? (
          <Text className="py-16 text-center text-sm text-danger">{inboxView.message}</Text>
        ) : inboxView?.kind === "loading" ? (
          <Text className="py-16 text-center text-sm text-foreground-muted">
            {t("Loading bot inbox…")}
          </Text>
        ) : (
          section
        )}
      </ScrollView>
    </View>
  );
}
