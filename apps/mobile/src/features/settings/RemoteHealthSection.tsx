import type { EnvironmentId, RemoteDiagnosticStatus } from "@akeru/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useMobileI18n } from "../../lib/i18n";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { SettingsSection } from "./components/SettingsSection";

const STATUS_LABELS: Record<RemoteDiagnosticStatus, string> = {
  pass: "OK",
  warning: "Warning",
  fail: "Failing",
};

const STATUS_CLASSES: Record<RemoteDiagnosticStatus, string> = {
  pass: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
  fail: "text-rose-600 dark:text-rose-400",
};

/** Read-only remote doctor status for mobile clients. Repairs stay in web/desktop Settings. */
export function RemoteHealthSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { t } = useMobileI18n();
  const doctor = useEnvironmentQuery(serverEnvironment.remoteDoctor({ environmentId, input: {} }));

  if (doctor.data !== null && !doctor.data.applicable) return null;
  if (doctor.data === null && doctor.error === null) return null;

  return (
    <SettingsSection title={t("Remote health")}>
      <View className="gap-3 p-4">
        <View className="flex-row items-center justify-between">
          <Text className="flex-1 text-sm text-foreground-muted">
            {doctor.error ?? t("Health checks for this environment")}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Refresh remote health")}
            disabled={doctor.isPending}
            onPress={doctor.refresh}
            className="rounded-lg bg-subtle px-3 py-2"
          >
            <Text className="text-sm font-t3-medium text-foreground">
              {doctor.isPending ? t("Checking") : t("Refresh")}
            </Text>
          </Pressable>
        </View>
        {doctor.data?.report?.checks.map((check) => (
          <View key={check.id} className="flex-row items-start justify-between gap-3">
            <View className="min-w-0 flex-1">
              <Text className="text-base text-foreground">{check.id}</Text>
              <Text className="text-sm text-foreground-muted">{check.message}</Text>
            </View>
            <Text className={`text-sm font-t3-medium ${STATUS_CLASSES[check.status]}`}>
              {STATUS_LABELS[check.status]}
            </Text>
          </View>
        ))}
      </View>
    </SettingsSection>
  );
}
