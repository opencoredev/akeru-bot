import type {
  EnvironmentId,
  SubscriptionProviderId,
  SubscriptionProviderStatus,
} from "@akeru/contracts";
import { providerSupportsBaseUrl } from "@akeru/client-runtime/provider-auth";
import { LoaderIcon } from "lucide-react";

import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";
import { SettingsEntityIcon } from "../settings/settingsDetailLayout";
import { ActiveLoginPanel, ProviderApiKeyForm } from "../settings/ProviderAccountControls";
import { SUBSCRIPTION_PROVIDERS } from "../settings/subscriptionProviders";
import { useSubscriptionAccounts } from "../settings/useSubscriptionAccounts";
import { Button } from "../ui/button";

/**
 * What the user still has to do for an account before its bots can reply:
 * sign in, sign in again, or wait for the check that follows a sign-in. Null
 * when the account is ready or its status has not loaded yet.
 */
export function providerConnectStep(
  status: SubscriptionProviderStatus | undefined,
): "connect" | "reconnect" | "checking" | null {
  if (!status) return null;

  if (!status.connected) return "connect";

  if (status.health === "revoked" || status.health === "expired") return "reconnect";

  return status.healthChecking ? "checking" : null;
}

/**
 * Asks the user to connect the account a bot runs on and runs the sign-in in
 * place, so fixing it never leaves the chat. Renders nothing once the account
 * is connected, which clears the card as soon as the post-login check lands.
 */
export function ProviderConnectCard({
  environmentId,
  provider,
  botName,
  id,
  className,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly provider: SubscriptionProviderId;
  readonly botName: string;
  readonly id?: string | undefined;
  readonly className?: string;
}) {
  const { t } = useI18n();
  const accounts = useSubscriptionAccounts(environmentId);
  const definition = SUBSCRIPTION_PROVIDERS.find((candidate) => candidate.id === provider);
  const status = accounts.statusByProvider.get(provider);

  if (!definition || environmentId === null) return null;

  const signingIn = accounts.activeLogin !== null || accounts.keyProvider !== null;
  const step = providerConnectStep(status);

  if (!signingIn && step === null) return null;

  if (!signingIn && step === "checking") {
    return (
      <div
        id={id}
        role="status"
        className="flex items-center justify-center gap-2 px-4 pb-3 text-xs text-muted-foreground"
      >
        <LoaderIcon className="size-3.5 animate-spin" />
        {t("Checking your {provider} account…", { provider: definition.label })}
      </div>
    );
  }

  const lapsed = step === "reconnect";

  return (
    <div
      id={id}
      role="status"
      data-provider-connect=""
      className={cn(
        "mx-4 max-w-3xl rounded-xl sm:mx-auto sm:w-full border bg-card text-card-foreground shadow-sm",
        className,
      )}
    >
      <div className="flex items-center gap-3 px-3 py-2.5">
        <SettingsEntityIcon icon={definition.icon} />
        <p className="min-w-0 flex-1 text-sm leading-5">
          {lapsed
            ? t("Reconnect {provider} to keep chatting with {bot}", {
                provider: definition.label,
                bot: botName,
              })
            : t("Connect {provider} to chat with {bot}", {
                provider: definition.label,
                bot: botName,
              })}
        </p>
        {signingIn ? null : (
          <Button
            size="xs"
            disabled={accounts.busyProvider !== null}
            onClick={() => void accounts.connect(definition)}
          >
            {accounts.busyProvider === provider ? (
              <LoaderIcon className="size-3.5 animate-spin" />
            ) : null}
            {lapsed ? t("Reconnect") : t("Connect")}
          </Button>
        )}
      </div>
      {accounts.activeLogin ? (
        <div className="border-t">
          <ActiveLoginPanel
            login={accounts.activeLogin}
            pastedCode={accounts.pastedCode}
            onPastedCodeChange={accounts.setPastedCode}
            onComplete={() => void accounts.complete()}
            onCancel={() => void accounts.cancelLogin()}
            completing={accounts.completing}
          />
        </div>
      ) : accounts.keyProvider ? (
        <div className="border-t pt-3">
          <ProviderApiKeyForm
            supportsBaseUrl={providerSupportsBaseUrl(accounts.keyProvider.id)}
            apiKey={accounts.pastedCode}
            baseUrl={accounts.baseUrl}
            busy={accounts.completing}
            error={accounts.error}
            onKeyChange={accounts.setPastedCode}
            onBaseUrlChange={accounts.setBaseUrl}
            onSave={() => void accounts.saveApiKey()}
            onCancel={accounts.closeApiKey}
          />
        </div>
      ) : accounts.error ? (
        <p role="alert" className="border-t px-3 py-2 text-xs text-destructive">
          {accounts.error}
        </p>
      ) : null}
    </div>
  );
}
