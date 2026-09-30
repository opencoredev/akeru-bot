/**
 * Per-bot usage rows.
 *
 * Presentation only: the screen owns the query, this owns every state's layout,
 * so loading, failed, empty, partial, and unavailable are all render-testable.
 *
 * @module features/usage/BotUsageDetails
 */
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SettingsSection } from "../settings/components/SettingsSection";
import type { BotUsageRow, BotUsageView } from "./botUsagePresentation";

/**
 * One label above its value. Stacking keeps the longest label and the widest
 * number readable at the largest native text size and on the narrowest phone,
 * where a two-column row would truncate one of them.
 */
function UsageRow(props: { readonly row: BotUsageRow; readonly first: boolean }) {
  return (
    <View className={props.first ? "gap-1 p-4" : "gap-1 border-t border-border-subtle p-4"}>
      <Text className="text-sm text-foreground-muted">{props.row.label}</Text>
      <Text
        className={
          props.row.unavailable
            ? "text-lg text-foreground-muted"
            : "text-lg tabular-nums text-foreground"
        }
      >
        {props.row.value}
      </Text>
      {props.row.caption === undefined ? null : (
        <Text className="text-sm text-foreground-muted">{props.row.caption}</Text>
      )}
    </View>
  );
}

export function BotUsageDetails(props: { readonly botName: string; readonly view: BotUsageView }) {
  if (props.view.kind === "loading") {
    return <Text className="py-16 text-center text-base text-foreground-muted">Loading…</Text>;
  }
  if (props.view.kind === "error") {
    return (
      <View className="gap-1 rounded-[24px] border-continuous bg-card px-4 py-3">
        <Text className="text-base text-foreground">{props.view.message}</Text>
        <Text className="text-sm text-foreground-muted">Pull down to try again.</Text>
      </View>
    );
  }
  if (props.view.kind === "empty") {
    return (
      <View className="gap-1 rounded-[24px] border-continuous bg-card px-4 py-3">
        <Text className="text-base text-foreground">{props.view.message}</Text>
        <Text className="text-sm text-foreground-muted">
          This bot has not recorded any usage yet.
        </Text>
      </View>
    );
  }

  return (
    <View className="gap-3" accessibilityLabel="Bot usage">
      <SettingsSection title={props.botName} card>
        {props.view.rows.map((row, index) => (
          <UsageRow key={row.key} row={row} first={index === 0} />
        ))}
      </SettingsSection>
      {props.view.partialNotice === null ? null : (
        <View className="rounded-[24px] border-continuous bg-card px-4 py-3">
          <Text className="text-sm text-foreground-muted">{props.view.partialNotice}</Text>
        </View>
      )}
    </View>
  );
}
