import { useState } from "react";
import { Pressable, View } from "react-native";
import type { SubscriptionProviderId } from "@t3tools/contracts";
import {
  providerAccessGuide,
  type ProviderAccessStatusInput,
} from "@t3tools/client-runtime/provider-access";

import { AppText as Text } from "../../components/AppText";
import { useMobileI18n } from "../../lib/i18n";

/**
 * Explains which subscription unlocks a provider, what this environment has,
 * and the next step. The detail lines stay folded so the list stays scannable.
 */
export function ProviderAccessSummary({
  provider,
  status,
  models,
}: {
  readonly provider: SubscriptionProviderId;
  readonly status: ProviderAccessStatusInput | undefined;
  readonly models?: ReadonlyArray<string> | undefined;
}) {
  const { t } = useMobileI18n();
  const [expanded, setExpanded] = useState(false);
  const guide = providerAccessGuide(provider, status, { models, t });
  if (!guide) return null;

  const rows: ReadonlyArray<readonly [string, string]> = [
    [
      t("Unlocks with"),
      guide.alternative ? `${guide.unlockedBy} ${guide.alternative}` : guide.unlockedBy,
    ],
    [t("Models"), guide.models],
    [t("API access"), guide.apiAccess],
    [t("Published limits"), guide.limits],
    [t("This environment"), guide.saved],
  ];

  return (
    <View className="gap-1">
      <Text className="text-sm text-foreground">
        <Text className="font-t3-medium">{guide.stateLabel}.</Text> {guide.nextStep}
      </Text>
      {guide.failure ? <Text className="text-sm text-danger">{guide.failure}</Text> : null}
      {guide.warning ? <Text className="text-sm text-warning">{guide.warning}</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        className="min-h-11 justify-center self-start"
      >
        <Text className="text-sm font-t3-medium text-foreground-muted">{t("Access details")}</Text>
      </Pressable>
      {expanded
        ? rows.map(([label, value]) => (
            <View key={label} className="gap-0.5 pb-1">
              <Text className="text-xs font-t3-medium text-foreground-muted">{label}</Text>
              <Text className="text-sm text-foreground-muted">{value}</Text>
            </View>
          ))
        : null}
    </View>
  );
}
