import { useMobileI18n } from "../../lib/i18n";
import {
  type EnvironmentConnectionPhase,
  type EnvironmentConnectionPresentation,
} from "@t3tools/client-runtime/connection";
import { connectionFailureMessage } from "@t3tools/client-runtime/i18n";
import { SymbolView } from "../../components/AppSymbol";
import { ActivityIndicator, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useThemeColor } from "../../lib/useThemeColor";

type Translate = ReturnType<typeof useMobileI18n>["t"];
type NoticeResource = "review" | "terminal";

function noticeTitle(
  t: Translate,
  phase: EnvironmentConnectionPhase,
  environmentLabel: string,
): string {
  const environment = environmentLabel;
  switch (phase) {
    case "offline":
      return t("You are offline");
    case "connecting":
      return t("Connecting to {environment}…", { environment });
    case "reconnecting":
      return t("Reconnecting to {environment}…", { environment });
    case "error":
      return t("{environment} is unavailable", { environment });
    case "available":
      return t("{environment} is disconnected", { environment });
    case "connected":
      return "";
  }
}

function noticeDetail(
  t: Translate,
  connection: EnvironmentConnectionPresentation,
  resource: NoticeResource,
): string {
  if (connection.error) {
    const reason = connection.errorCode ? t(connectionFailureMessage(connection.errorCode)) : null;
    const retrying = t("The app will keep retrying automatically.");
    return [retrying, reason, connection.error].filter(Boolean).join(" ");
  }

  switch (connection.phase) {
    case "offline":
      return resource === "review"
        ? t("Cached data remains available. The review will load when your connection returns.")
        : t("Cached data remains available. The terminal will load when your connection returns.");
    case "connecting":
    case "reconnecting":
      return resource === "review"
        ? t("The review will load as soon as the environment is ready.")
        : t("The terminal will load as soon as the environment is ready.");
    case "available":
    case "error":
      return resource === "review"
        ? t("Reconnect the environment to load the review.")
        : t("Reconnect the environment to load the terminal.");
    case "connected":
      return "";
  }
}

export function EnvironmentConnectionNotice(props: {
  readonly environmentLabel: string;
  readonly connection: EnvironmentConnectionPresentation;
  readonly resourceName: NoticeResource;
  readonly onRetry: () => void;
}) {
  const { t } = useMobileI18n();
  const iconColor = String(useThemeColor("--color-icon-muted"));
  const isRetrying =
    props.connection.phase === "connecting" || props.connection.phase === "reconnecting";

  return (
    <View className="flex-1 items-center justify-center px-8">
      <View className="max-w-[320px] items-center gap-3">
        {isRetrying ? (
          <ActivityIndicator size="small" color={iconColor} />
        ) : (
          <SymbolView
            name={props.connection.phase === "offline" ? "wifi.slash" : "bolt.horizontal.circle"}
            size={24}
            tintColor={iconColor}
            type="monochrome"
          />
        )}

        <Text className="text-center text-lg font-t3-bold text-foreground">
          {noticeTitle(t, props.connection.phase, props.environmentLabel)}
        </Text>
        <Text className="text-center text-sm leading-normal text-foreground-muted">
          {noticeDetail(t, props.connection, props.resourceName)}
          {props.connection.traceId ? (
            <>
              {` ${t("Trace ID:")} `}
              <Text
                accessibilityHint={t("Copies the trace ID")}
                accessibilityRole="button"
                className="underline decoration-dotted"
                onPress={() =>
                  copyTextWithHaptic(props.connection.traceId!, {
                    target: "connection-trace-id",
                  })
                }
              >
                {props.connection.traceId}
              </Text>
            </>
          ) : null}
        </Text>

        {props.connection.phase !== "offline" ? (
          <Pressable
            accessibilityRole="button"
            className="mt-1 rounded-full bg-subtle px-4 py-2.5 active:opacity-70"
            onPress={props.onRetry}
          >
            <Text className="text-sm font-t3-bold text-foreground">{t("Retry now")}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
