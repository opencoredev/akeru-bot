import type {
  EnvironmentId,
  ImageGenerationSettings,
  ImageProviderId,
  ImageProviderStatus,
} from "@akeru/contracts";
import { IMAGE_PROVIDER_IDS } from "@akeru/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@akeru/client-runtime/state/runtime";
import { LoaderIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useI18n } from "../../i18n";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { openSettings, useSettingsEnvironmentId } from "../../settingsDialogStore";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  IMAGE_PROVIDER_LABELS,
  IMAGE_PROVIDER_SUBSCRIPTIONS,
  effectiveDefaultProvider,
  effectiveFallbackOrder,
  fallbackOrderError,
  imageProviderAccessLabel,
  imageProviderGenerationLabel,
  imageProviderHealthDisplay,
  imageProviderHealthTestLabel,
  imageProviderOperationsLabel,
  imageProviderTogglePatch,
  isImageProviderEnabled,
} from "@akeru/client-runtime/image-generation";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { subscriptionProviderTargetId } from "./subscriptionProviders";

const NO_PROVIDER = "none";

const IMAGE_PROVIDER_ICONS: Readonly<Record<ImageProviderId, string>> = {
  chatgpt: "/provider-icons/openai.svg",
  grok: "/provider-icons/xai.svg",
};

function commandError(result: AtomCommandResult<unknown, unknown>): string {
  if (result._tag !== "Failure") return "The request failed.";
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "The request failed.";
}

// The confirm host is mounted at the app root, so a missing host means the
// app is tearing down. Disconnect is destructive, so that case fails closed.
function confirmAction(message: string): Promise<boolean> {
  return requestConfirmDialog(message, { variant: "destructive" }) ?? Promise.resolve(false);
}

export function ImageGenerationSettingsPanel() {
  const environmentId = useSettingsEnvironmentId();
  return (
    <SettingsPageContainer>
      {environmentId === null ? (
        <SettingsSection id="image-generation" title="Image generation">
          <SettingsRow
            title="No environment"
            description="Connect to an environment to set up image generation."
          />
        </SettingsSection>
      ) : (
        <ImageGenerationSettingsContent key={environmentId} environmentId={environmentId} />
      )}
    </SettingsPageContainer>
  );
}

export function ImageGenerationSettingsContent({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const settings = useEnvironmentSettings(environmentId, (value) => value.imageGeneration);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const providersQuery = useEnvironmentQuery(
    serverEnvironment.imageProviders({ environmentId, input: {} }),
  );
  const testProvider = useAtomCommand(serverEnvironment.testImageProvider, {
    reportFailure: false,
  });
  const logoutSubscription = useAtomCommand(serverEnvironment.logoutSubscriptionAuth, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState<{ provider: ImageProviderId; action: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const statusByProvider = useMemo(
    () => new Map(providersQuery.data?.providers.map((status) => [status.provider, status]) ?? []),
    [providersQuery.data],
  );

  const toggle = (provider: ImageProviderId, enabled: boolean) => {
    setError(null);
    updateSettings({ imageGeneration: imageProviderTogglePatch(settings, provider, enabled) });
  };

  const runHealthTest = async (provider: ImageProviderId) => {
    setBusy({ provider, action: "test" });
    setError(null);
    const result = await testProvider({ environmentId, input: { provider } });
    setBusy(null);
    if (result._tag === "Failure") setError(commandError(result));
    providersQuery.refresh();
  };

  const disconnect = async (provider: ImageProviderId) => {
    const label = IMAGE_PROVIDER_LABELS[provider];
    const confirmed = await confirmAction(
      `Disconnect the ${label} subscription? Chats that use ${label} will also be signed out.`,
    );
    if (!confirmed) return;
    setBusy({ provider, action: "disconnect" });
    setError(null);
    const result = await logoutSubscription({
      environmentId,
      input: { provider: IMAGE_PROVIDER_SUBSCRIPTIONS[provider] },
    });
    setBusy(null);
    if (result._tag === "Failure") setError(commandError(result));
    providersQuery.refresh();
  };

  const openProviderLogin = (provider: ImageProviderId) =>
    openSettings(
      "providers",
      subscriptionProviderTargetId(IMAGE_PROVIDER_SUBSCRIPTIONS[provider]),
      environmentId,
    );

  return (
    <>
      <SettingsSection id="image-generation" title="Image generation">
        <SettingsRow
          title="Subscriptions"
          description="Connect ChatGPT or Grok here and choose which subscription bots will use when image creation becomes available. Image creation is not available in chats yet. This does not change a bot’s chat model."
          status={
            providersQuery.error ? (
              <span className="text-destructive">
                Could not load image providers: {providersQuery.error}
              </span>
            ) : null
          }
          control={
            providersQuery.error ? (
              <Button
                size="xs"
                variant="outline"
                disabled={providersQuery.isPending}
                onClick={providersQuery.refresh}
                aria-label="Retry loading image providers"
              >
                Retry
              </Button>
            ) : null
          }
        />
        {IMAGE_PROVIDER_IDS.map((provider) => (
          <ImageProviderRow
            key={provider}
            provider={provider}
            status={statusByProvider.get(provider)}
            enabled={isImageProviderEnabled(settings, provider)}
            loadFailed={providersQuery.error !== null}
            busyAction={busy?.provider === provider ? busy.action : null}
            disabled={busy !== null}
            onToggle={(enabled) => toggle(provider, enabled)}
            onTest={() => void runHealthTest(provider)}
            onDisconnect={() => void disconnect(provider)}
            onConnect={() => openProviderLogin(provider)}
          />
        ))}
        {error ? (
          <p role="alert" className="px-3 text-xs text-destructive sm:px-4">
            {error}
          </p>
        ) : null}
      </SettingsSection>
      <ImageGenerationRoutingSection
        settings={settings}
        onChange={(patch) => updateSettings({ imageGeneration: patch })}
      />
    </>
  );
}

export function ImageProviderRow({
  provider,
  status,
  enabled,
  loadFailed,
  busyAction,
  disabled,
  onToggle,
  onTest,
  onDisconnect,
  onConnect,
}: {
  readonly provider: ImageProviderId;
  readonly status: ImageProviderStatus | undefined;
  readonly enabled: boolean;
  readonly loadFailed: boolean;
  readonly busyAction: string | null;
  readonly disabled: boolean;
  readonly onToggle: (enabled: boolean) => void;
  readonly onTest: () => void;
  readonly onDisconnect: () => void;
  readonly onConnect: () => void;
}) {
  const { t } = useI18n();
  const label = IMAGE_PROVIDER_LABELS[provider];
  const health = imageProviderHealthDisplay(status, enabled, loadFailed);
  const connected = status?.connected === true;
  const needsReconnect = status?.health === "revoked" || status?.health === "expired";
  // A missing subscription is one fact: the description says it and Connect fixes it.
  const disconnected = status !== undefined && !connected;

  return (
    <SettingsRow
      {...searchableSetting(`image-provider-${provider}`)}
      title={
        <span className="flex items-center gap-2">
          <img
            src={IMAGE_PROVIDER_ICONS[provider]}
            alt=""
            className="size-4 shrink-0 brightness-0 dark:invert"
          />
          {label}
          {disconnected ? null : (
            <Badge variant={health.variant} className="h-4 px-1.5 text-[10px]">
              {health.label}
            </Badge>
          )}
        </span>
      }
      description={
        status
          ? imageProviderAccessLabel(status, t)
          : loadFailed
            ? "Could not load provider status."
            : "Loading provider status…"
      }
      status={
        status && !disconnected ? (
          <div className="space-y-0.5">
            <div>
              {imageProviderOperationsLabel(status)}
              {" · "}
              {imageProviderGenerationLabel(status, formatRelativeTimeLabel)}
              {" · "}
              {imageProviderHealthTestLabel(status, formatRelativeTimeLabel)}
            </div>
            {status.lastFailure ? (
              <div className="text-destructive">
                Last failure {formatRelativeTimeLabel(status.lastFailure.at)}:{" "}
                {status.lastFailure.message}
              </div>
            ) : null}
            {status.repairAction ? <div>Next step: {status.repairAction}</div> : null}
          </div>
        ) : null
      }
      control={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {connected ? (
            <>
              <Button
                size="xs"
                variant="outline"
                disabled={disabled}
                onClick={onTest}
                aria-label={`Run ${label} image health test`}
              >
                {busyAction === "test" ? <LoaderIcon className="size-3 animate-spin" /> : null}
                Test
              </Button>
              {needsReconnect ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={onConnect}
                  aria-label={`Reconnect ${label} subscription`}
                >
                  Reconnect
                </Button>
              ) : null}
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={disabled}
                onClick={onDisconnect}
                aria-label={`Disconnect ${label} subscription`}
              >
                Disconnect
              </Button>
            </>
          ) : (
            <Button
              size="xs"
              variant="outline"
              disabled={!status}
              onClick={onConnect}
              aria-label={t("Connect {provider} subscription", { provider: label })}
            >
              {t("Connect")}
            </Button>
          )}
          <Switch
            checked={enabled}
            disabled={!enabled && !connected}
            onCheckedChange={(checked) => onToggle(Boolean(checked))}
            aria-label={`Use ${label} for image generation`}
          />
        </div>
      }
    />
  );
}

export function ImageGenerationRoutingSection({
  settings,
  onChange,
}: {
  readonly settings: ImageGenerationSettings;
  readonly onChange: (patch: {
    defaultProvider?: ImageProviderId | null;
    fallbackOrder?: ImageProviderId[];
  }) => void;
}) {
  const { t } = useI18n();
  const enabledProviders = IMAGE_PROVIDER_IDS.filter((id) => isImageProviderEnabled(settings, id));
  const defaultProvider = effectiveDefaultProvider(settings);
  const order = effectiveFallbackOrder(settings);
  const [orderError, setOrderError] = useState<string | null>(null);

  const selectOrder = (first: string | null) => {
    const next = [...order].sort((a, b) => (a === first ? -1 : b === first ? 1 : 0));
    const validation = fallbackOrderError(next, settings);
    setOrderError(validation);
    if (!validation) onChange({ fallbackOrder: next });
  };

  return (
    <SettingsSection title="Routing">
      <SettingsRow
        {...searchableSetting("image-default-provider", t)}
        title="Default provider"
        description={
          enabledProviders.length === 0
            ? "Turn on a provider above to choose a default."
            : "Bots without their own choice create images with this provider."
        }
        control={
          <Select
            value={defaultProvider ?? NO_PROVIDER}
            disabled={enabledProviders.length === 0}
            onValueChange={(value) => {
              const next = IMAGE_PROVIDER_IDS.find((id) => id === value);
              if (next) onChange({ defaultProvider: next });
            }}
          >
            <SelectTrigger className="w-full sm:w-44" aria-label="Default image provider">
              <SelectValue>
                {defaultProvider ? IMAGE_PROVIDER_LABELS[defaultProvider] : "None enabled"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {enabledProviders.map((id) => (
                <SelectItem key={id} value={id}>
                  {IMAGE_PROVIDER_LABELS[id]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {order.length === 2 ? (
        <SettingsRow
          {...searchableSetting("image-fallback-order", t)}
          title="Fallback order"
          description="When the first provider fails, the next one tries the same request."
          status={orderError ? <span className="text-destructive">{orderError}</span> : null}
          control={
            <Select value={order[0]} onValueChange={selectOrder}>
              <SelectTrigger className="w-full sm:w-44" aria-label="Image fallback order">
                <SelectValue>
                  {order.map((id) => IMAGE_PROVIDER_LABELS[id]).join(", then ")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {IMAGE_PROVIDER_IDS.map((id) => (
                  <SelectItem key={id} value={id}>
                    {IMAGE_PROVIDER_LABELS[id]}, then{" "}
                    {IMAGE_PROVIDER_LABELS[id === "chatgpt" ? "grok" : "chatgpt"]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
    </SettingsSection>
  );
}
