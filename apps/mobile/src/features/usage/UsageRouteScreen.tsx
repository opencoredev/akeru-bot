import type { UsagePlanWindow, UsageProviderPlanLimits } from "@t3tools/contracts";
import type { MergedUsage } from "@t3tools/shared/usageMerge";
import { makeWindow } from "@t3tools/shared/usageFormat";
import { useEffect, useState } from "react";
import { Platform, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useUsage, type EnvironmentUsageStatus } from "../../state/usage";
import { SettingsSection } from "../settings/components/SettingsSection";

const PLAN_LABELS = {
  "openai-codex": "ChatGPT",
  anthropic: "Claude",
  cursor: "Cursor",
  xai: "Grok",
  "kimi-for-coding": "Kimi For Coding",
  "opencode-go": "OpenCode Go",
} as const;

export function UsageRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [usageWindow] = useState(() => makeWindow(30));
  const { merged, environments, isPending, isPartial, refresh } = useUsage(usageWindow);
  const refreshing = environments.some((entry) => entry.isPending && entry.summary !== null);
  const planLimits = merged.planLimits.filter((entry) => entry.status === "ok");

  useEffect(() => {
    const timer = setInterval(
      () => {
        refresh();
      },
      5 * 60 * 1000,
    );
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Usage" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
      >
        <UsageCoverageNotice environments={environments} merged={merged} isPartial={isPartial} />

        {isPending ? (
          <Text className="py-16 text-center text-base text-foreground-muted">
            Reading plan limits…
          </Text>
        ) : environments.length === 0 ? (
          <Text className="py-16 text-center text-base text-foreground-muted">
            Connect an environment to see usage.
          </Text>
        ) : planLimits.length === 0 ? (
          <Text className="py-16 text-center text-base text-foreground-muted">
            Connect a subscription in Settings to see plan limits.
          </Text>
        ) : (
          planLimits.map((limits) => <PlanCard key={limits.provider} limits={limits} />)
        )}
      </ScrollView>
    </View>
  );
}

function PlanCard(props: { readonly limits: UsageProviderPlanLimits }) {
  const title =
    props.limits.plan === null
      ? PLAN_LABELS[props.limits.provider]
      : `${PLAN_LABELS[props.limits.provider]} · ${props.limits.plan}`;

  return (
    <SettingsSection title={title} card>
      {props.limits.windows.length === 0 ? (
        <Text className="p-4 text-base text-foreground-muted">No limit data yet.</Text>
      ) : (
        props.limits.windows.map((window, index) => (
          <PlanWindowRow
            key={`${window.kind}:${window.label}`}
            window={window}
            first={index === 0}
          />
        ))
      )}
    </SettingsSection>
  );
}

function PlanWindowRow(props: { readonly window: UsagePlanWindow; readonly first: boolean }) {
  const remaining = Math.min(100, Math.max(0, 100 - props.window.usedPercent));
  return (
    <View className={props.first ? "gap-2 p-4" : "gap-2 border-t border-border-subtle p-4"}>
      <View className="flex-row items-baseline justify-between gap-3">
        <Text className="text-lg text-foreground">{props.window.label}</Text>
        <Text className="text-lg tabular-nums text-foreground">{Math.round(remaining)}% left</Text>
      </View>
      <View className="h-1.5 overflow-hidden rounded-full bg-subtle">
        <View className="h-full bg-foreground" style={{ width: `${remaining}%` }} />
      </View>
      <Text className="text-sm text-foreground-muted">{formatReset(props.window.resetsAt)}</Text>
    </View>
  );
}

function formatReset(resetsAt: string | null): string {
  if (resetsAt === null) return "Reset time unknown";
  const deltaMs = Date.parse(resetsAt) - Date.now();
  if (Number.isNaN(deltaMs) || deltaMs <= 0) return "Resets soon";
  const hours = Math.round(deltaMs / (60 * 60 * 1000));
  if (hours < 48) return `Resets in ${hours}h`;
  return `Resets in ${Math.round(hours / 24)}d`;
}

function UsageCoverageNotice(props: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly merged: MergedUsage;
  readonly isPartial: boolean;
}) {
  const failed = props.environments.filter((environment) => environment.error !== null);
  const stale = props.environments.filter((environment) =>
    props.merged.staleEnvironments.includes(environment.environmentId),
  );
  if (failed.length === 0 && stale.length === 0 && !props.isPartial) {
    return null;
  }

  return (
    <View className="gap-1 rounded-[16px] border-continuous bg-card px-4 py-3">
      {props.isPartial ? (
        <Text className="text-sm text-foreground-muted">
          Some environments are still reporting.
        </Text>
      ) : null}
      {failed.map((environment) => (
        <Text key={environment.environmentId} className="text-sm text-foreground-muted">
          {environment.label} could not report usage.
        </Text>
      ))}
      {stale.map((environment) => (
        <Text key={environment.environmentId} className="text-sm text-foreground-muted">
          {environment.label} runs an older server version and is excluded from totals.
        </Text>
      ))}
    </View>
  );
}
