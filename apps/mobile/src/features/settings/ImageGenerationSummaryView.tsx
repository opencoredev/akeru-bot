import {
  IMAGE_PROVIDER_IDS,
  type ImageGenerationSettings,
  type ImageProviderStatus,
} from "@akeru/contracts";
import {
  IMAGE_PROVIDER_LABELS,
  effectiveDefaultProvider,
  effectiveFallbackOrder,
  imageProviderAccessLabel,
  imageProviderGenerationLabel,
  imageProviderHealthDisplay,
  imageProviderHealthTestLabel,
  imageProviderOperationsLabel,
  isImageProviderEnabled,
} from "@akeru/client-runtime/image-generation";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useMobileI18n } from "../../lib/i18n";
import { relativeTime } from "../../lib/time";
import { SettingsSection } from "./components/SettingsSection";

const HEALTH_TEXT_CLASS = {
  success: "text-success",
  error: "text-danger",
  warning: "text-warning",
  secondary: "text-foreground-muted",
} as const;

const ago = (iso: string) => `${relativeTime(iso)} ago`;

export interface ImageProvidersQueryView {
  readonly data: { readonly providers: ReadonlyArray<ImageProviderStatus> } | null;
  readonly error: string | null;
  readonly isPending: boolean;
}

/**
 * Read-only view of the environment's image generation setup. Changes happen
 * in the desktop or web app; mobile shows the same status details.
 */
export function ImageGenerationSummaryView({
  settings,
  query,
  onRetry,
}: {
  readonly settings: ImageGenerationSettings;
  readonly query: ImageProvidersQueryView;
  readonly onRetry: () => void;
}) {
  const { t } = useMobileI18n();
  const statuses = new Map(query.data?.providers.map((status) => [status.provider, status]) ?? []);
  const loadFailed = query.data === null && query.error !== null;
  const defaultProvider = effectiveDefaultProvider(settings);
  const order = effectiveFallbackOrder(settings);

  return (
    <>
      <SettingsSection title="Image generation" card>
        {loadFailed ? (
          <View className="items-start gap-3 p-4">
            <Text className="text-sm text-danger">
              Could not load image providers: {query.error}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry loading image providers"
              className="rounded-full bg-card px-4 py-2 active:opacity-70"
              onPress={onRetry}
            >
              <Text className="text-sm font-t3-medium text-foreground">Try again</Text>
            </Pressable>
          </View>
        ) : null}
        {IMAGE_PROVIDER_IDS.map((provider, index) => {
          const status = statuses.get(provider);
          const enabled = isImageProviderEnabled(settings, provider);
          const health = imageProviderHealthDisplay(status, enabled, loadFailed);
          // A missing subscription is one fact, so the row states it once.
          const disconnected = status !== undefined && !status.connected;
          return (
            <View
              key={provider}
              className={
                index === 0 && !loadFailed ? "gap-1 p-4" : "gap-1 border-t border-border-subtle p-4"
              }
            >
              <View className="flex-row items-center justify-between gap-3">
                <Text className="text-base font-t3-medium text-foreground">
                  {IMAGE_PROVIDER_LABELS[provider]}
                </Text>
                {disconnected ? null : (
                  <Text className={`text-sm font-t3-medium ${HEALTH_TEXT_CLASS[health.variant]}`}>
                    {health.label}
                  </Text>
                )}
              </View>
              {disconnected ? (
                <Text className="text-sm text-foreground-muted">
                  {imageProviderAccessLabel(status, t)}
                </Text>
              ) : status ? (
                <>
                  <Text className="text-sm text-foreground-muted">
                    {imageProviderAccessLabel(status, t)}
                  </Text>
                  <Text className="text-sm text-foreground-muted">
                    {imageProviderOperationsLabel(status)} ·{" "}
                    {imageProviderGenerationLabel(status, ago)}
                  </Text>
                  <Text className="text-sm text-foreground-muted">
                    {imageProviderHealthTestLabel(status, ago)}
                  </Text>
                  {status.lastFailure ? (
                    <Text className="text-sm text-danger">
                      Last failure {ago(status.lastFailure.at)}: {status.lastFailure.message}
                    </Text>
                  ) : null}
                  {status.repairAction ? (
                    <Text className="text-sm text-foreground">
                      Next step: {status.repairAction}
                    </Text>
                  ) : null}
                </>
              ) : (
                <Text className="text-sm text-foreground-muted">
                  {loadFailed ? "Provider status unavailable." : "Loading provider status…"}
                </Text>
              )}
            </View>
          );
        })}
      </SettingsSection>
      <SettingsSection title="Routing" card>
        <View className="gap-1 p-4">
          <Text className="text-xs font-t3-medium text-foreground-muted">Default provider</Text>
          <Text className="text-sm text-foreground">
            {defaultProvider ? IMAGE_PROVIDER_LABELS[defaultProvider] : "None enabled"}
          </Text>
        </View>
        {order.length === 2 ? (
          <View className="gap-1 border-t border-border-subtle p-4">
            <Text className="text-xs font-t3-medium text-foreground-muted">Fallback order</Text>
            <Text className="text-sm text-foreground">
              {order.map((id) => IMAGE_PROVIDER_LABELS[id]).join(", then ")}
            </Text>
          </View>
        ) : null}
        <Text className="border-t border-border-subtle p-4 text-sm text-foreground-muted">
          Change image generation in Settings on desktop or web.
        </Text>
      </SettingsSection>
    </>
  );
}
