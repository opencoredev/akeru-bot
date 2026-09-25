import { ExternalLinkIcon, LoaderIcon, LogOutIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  EnvironmentId,
  SubscriptionAuthLoginProgress,
  SubscriptionAuthStartResult,
  SubscriptionProviderId,
  SubscriptionProviderStatus,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

import {
  anyProviderHealthChecking,
  apiKeyStartInput,
  apiKeyValidationError,
  HEALTH_CHECK_REFRESH_MS,
  providerUsesApiKey,
  providerSupportsBaseUrl,
} from "@t3tools/client-runtime/provider-auth";
import { providerAccessModelNames } from "@t3tools/client-runtime/provider-access";
import type { MessageKey } from "@t3tools/client-runtime/i18n";

import { useAtomValue } from "@effect/atom-react";
import { useI18n } from "../../i18n";
import { useSettingsEnvironmentId } from "../../settingsDialogStore";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ProviderAccessDetails } from "./ProviderAccessDetails";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { SignInCodeCopy } from "./SignInCodeCopy";
import {
  SUBSCRIPTION_PROVIDERS,
  subscriptionProviderTargetId,
  type SubscriptionProviderDefinition,
} from "./subscriptionProviders";

export { SUBSCRIPTION_PROVIDERS } from "./subscriptionProviders";

interface ActiveLogin {
  readonly flow: SubscriptionAuthStartResult;
  readonly providerLabel: string;
  readonly error: string | null;
}

const healthLabels: Readonly<
  Record<NonNullable<SubscriptionProviderStatus["health"]>, MessageKey>
> = {
  missing: "Missing",
  detected: "Detected",
  healthy: "Healthy",
  expired: "Expired",
  revoked: "Revoked",
  failed: "Failed",
  unsupported: "Unsupported",
  disabled: "Disabled",
  "failed-first-request": "First request failed",
  recovered: "Recovered",
};

function providerBadgeLabel(status: SubscriptionProviderStatus | undefined): MessageKey {
  if (status?.connected !== true) return "Missing";
  if (status.healthChecking === true) return "Checking health…";
  if (
    status.health === "expired" ||
    status.health === "revoked" ||
    status.health === "failed" ||
    status.health === "failed-first-request"
  ) {
    return healthLabels[status.health];
  }
  return "Connected";
}

function healthBadgeVariant(health: SubscriptionProviderStatus["health"] | undefined) {
  if (health === "healthy" || health === "recovered") return "success" as const;
  if (
    health === "expired" ||
    health === "revoked" ||
    health === "failed" ||
    health === "failed-first-request"
  ) {
    return "error" as const;
  }
  if (health === "detected") return "warning" as const;
  return "secondary" as const;
}

function commandError(
  result: AtomCommandResult<unknown, unknown>,
  t: (key: MessageKey) => string,
): string {
  if (result._tag !== "Failure") return t("The request failed.");
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : t("The request failed.");
}

export function ProviderLoginCard({
  definition,
  status,
  busy,
  disabled = false,
  onConnect,
  onDisconnect,
  onTest,
  onApiKey,
  models,
}: {
  readonly definition: SubscriptionProviderDefinition;
  readonly status: SubscriptionProviderStatus | undefined;
  /** Live model names from this environment, listed in the access details. */
  readonly models?: ReadonlyArray<string> | undefined;
  readonly busy: boolean;
  readonly disabled?: boolean;
  readonly onConnect: () => void;
  readonly onDisconnect: () => void;
  readonly onTest: () => void;
  readonly onApiKey?: () => void;
}) {
  const { t } = useI18n();
  const connected = status?.connected === true;
  const ProviderIcon = typeof definition.icon === "string" ? null : definition.icon;

  return (
    <SettingsRow
      id={subscriptionProviderTargetId(definition.id)}
      title={
        <span className="flex items-center gap-2">
          {ProviderIcon ? (
            <ProviderIcon className="size-4 shrink-0" />
          ) : (
            <img
              src={definition.icon as string}
              alt=""
              className="size-4 shrink-0 brightness-0 dark:invert"
            />
          )}
          {definition.label}
          <Badge variant={healthBadgeVariant(status?.health)} className="h-4 px-1.5 text-[10px]">
            {t(providerBadgeLabel(status))}
          </Badge>
        </span>
      }
      description={providerUsesApiKey(status) ? undefined : t(definition.description)}
      status={
        status?.authMode === "api-key"
          ? status.baseUrl
            ? t("API key saved · {baseUrl}", { baseUrl: status.baseUrl })
            : t("API key saved")
          : t(definition.subscription)
      }
      control={
        <div className="flex flex-wrap items-center gap-1.5">
          {definition.id !== "opencode-go" && onApiKey ? (
            <Button size="xs" variant="ghost-muted" disabled={busy || disabled} onClick={onApiKey}>
              {providerUsesApiKey(status) ? t("Reconnect key") : t("API key")}
            </Button>
          ) : null}
          {connected ? (
            <div className="flex items-center gap-1.5">
              <Button size="xs" variant="outline" disabled={busy || disabled} onClick={onTest}>
                {busy ? (
                  <LoaderIcon className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCwIcon className="size-3.5" />
                )}
                {providerUsesApiKey(status) ? t("Check key") : t("Check OAuth")}
              </Button>
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={busy || disabled}
                onClick={onConnect}
              >
                {providerUsesApiKey(status) && definition.id !== "opencode-go"
                  ? t("Use OAuth")
                  : t("Reconnect")}
              </Button>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={t("Disconnect {provider}", { provider: definition.label })}
                disabled={busy || disabled}
                onClick={onDisconnect}
              >
                <LogOutIcon className="size-3.5" />
              </Button>
            </div>
          ) : (
            <Button size="xs" variant="outline" disabled={busy || disabled} onClick={onConnect}>
              {busy ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
              {t("Connect")}
            </Button>
          )}
        </div>
      }
    >
      <ProviderAccessDetails provider={definition.id} status={status} models={models} />
    </SettingsRow>
  );
}

export function ProviderApiKeyForm({
  supportsBaseUrl = true,
  apiKey,
  baseUrl,
  busy,
  error,
  onKeyChange,
  onBaseUrlChange,
  onSave,
  onCancel,
}: {
  readonly supportsBaseUrl?: boolean;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onKeyChange: (value: string) => void;
  readonly onBaseUrlChange: (value: string) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}) {
  const { t } = useI18n();
  return (
    <form
      className="space-y-3 px-3 pb-3 sm:px-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <label className="block space-y-1 text-sm">
        <span>{t("API key")}</span>
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          disabled={busy}
          onChange={(event) => onKeyChange(event.currentTarget.value)}
        />
      </label>
      {supportsBaseUrl ? (
        <label className="block space-y-1 text-sm">
          <span>{t("Base URL (optional)")}</span>
          <Input
            type="url"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("Provider default")}
            value={baseUrl}
            disabled={busy}
            onChange={(event) => onBaseUrlChange(event.currentTarget.value)}
          />
        </label>
      ) : null}
      <p className="text-[13px] text-muted-foreground">
        {supportsBaseUrl
          ? t("The environment sends this key to the selected endpoint.")
          : t("Grok uses its default endpoint.")}{" "}
        {t("API billing can be separate from your subscription.")}
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="xs" disabled={busy || !apiKey.trim()}>
          {busy ? t("Saving…") : t("Save")}
        </Button>
        <Button type="button" size="xs" variant="ghost-muted" disabled={busy} onClick={onCancel}>
          {t("Cancel")}
        </Button>
      </div>
    </form>
  );
}

function ActiveLoginPanel({
  login,
  pastedCode,
  onPastedCodeChange,
  onComplete,
  onCancel,
  completing,
}: {
  readonly login: ActiveLogin;
  readonly pastedCode: string;
  readonly onPastedCodeChange: (value: string) => void;
  readonly onComplete: () => void;
  readonly onCancel: () => void;
  readonly completing: boolean;
}) {
  const { t } = useI18n();
  const { flow } = login;
  const isApiKey = flow.provider === "opencode-go";
  return (
    <div className="mx-3 mb-3 space-y-3 rounded-xl border bg-muted/30 p-4 sm:mx-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">
          {flow.instructions ?? t("Finish signing in on the provider page.")}
        </p>
        <Button
          size="xs"
          variant="outline"
          render={<a href={flow.url} target="_blank" rel="noreferrer" />}
        >
          {isApiKey ? t("Open OpenCode") : t("Open sign-in")}
          <ExternalLinkIcon className="size-3.5" />
        </Button>
      </div>

      {flow.userCode ? <SignInCodeCopy code={flow.userCode} /> : null}

      {flow.completion === "paste" ? (
        <div className="flex gap-2">
          <Input
            type={isApiKey ? "password" : "text"}
            autoComplete="off"
            value={pastedCode}
            onChange={(event) => onPastedCodeChange(event.currentTarget.value)}
            placeholder={isApiKey ? t("Paste the API key") : t("Paste the authorization code")}
            aria-label={isApiKey ? t("API key") : t("Authorization code")}
            className="flex-1"
          />
          <Button
            size="xs"
            disabled={pastedCode.trim().length === 0 || completing}
            onClick={onComplete}
          >
            {completing ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
            {t("Connect")}
          </Button>
        </div>
      ) : !login.error ? (
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <LoaderIcon className="size-3.5 animate-spin" />
          {t("Waiting for approval…")}
        </div>
      ) : null}

      {login.error ? (
        <p role="alert" className="text-[13px] text-destructive">
          {login.error}
        </p>
      ) : null}

      <Button size="xs" variant="ghost-muted" disabled={completing} onClick={onCancel}>
        {t("Cancel")}
      </Button>
    </div>
  );
}

export function ProvidersPanel() {
  const environmentId = useSettingsEnvironmentId();
  return <ProviderConnections key={environmentId ?? "none"} environmentId={environmentId} />;
}

function ProviderConnections({ environmentId }: { readonly environmentId: EnvironmentId | null }) {
  const { t } = useI18n();
  const statusQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.subscriptionAuth({ environmentId, input: {} }),
  );
  const serverProviders = useAtomValue(serverEnvironment.configValueAtom(environmentId))?.providers;
  const startAuth = useAtomCommand(serverEnvironment.startSubscriptionAuth, {
    reportFailure: false,
  });
  const pollAuth = useAtomCommand(serverEnvironment.pollSubscriptionAuth, {
    reportFailure: false,
  });
  const completeAuth = useAtomCommand(serverEnvironment.completeSubscriptionAuth, {
    reportFailure: false,
  });
  const cancelAuth = useAtomCommand(serverEnvironment.cancelSubscriptionAuth, {
    reportFailure: false,
  });
  const logoutAuth = useAtomCommand(serverEnvironment.logoutSubscriptionAuth, {
    reportFailure: false,
  });
  const testAuth = useAtomCommand(serverEnvironment.testSubscriptionAuth, {
    reportFailure: false,
  });

  const [activeLogin, setActiveLogin] = useState<ActiveLogin | null>(null);
  const [busyProvider, setBusyProvider] = useState<SubscriptionProviderId | null>(null);
  const [pastedCode, setPastedCode] = useState("");
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyProvider, setKeyProvider] = useState<SubscriptionProviderDefinition | null>(null);
  const [baseUrl, setBaseUrl] = useState("");

  const statusByProvider = useMemo(
    () => new Map(statusQuery.data?.providers.map((status) => [status.provider, status]) ?? []),
    [statusQuery.data],
  );
  const settleLogin = useCallback(
    (progress: SubscriptionAuthLoginProgress) => {
      if (progress.status === "connected") {
        setActiveLogin(null);
        setBusyProvider(null);
        setPastedCode("");
        statusQuery.refresh();
        return true;
      }
      if (progress.status === "failed") {
        setActiveLogin((current) => (current ? { ...current, error: progress.error } : current));
        setBusyProvider(null);
      }
      return false;
    },
    [statusQuery],
  );

  // The server checks health right after a login stores credentials. Refresh until
  // that check lands so the badge does not stay on "Checking health…".
  useEffect(() => {
    if (!anyProviderHealthChecking(statusQuery.data?.providers)) return;
    const timer = setTimeout(() => statusQuery.refresh(), HEALTH_CHECK_REFRESH_MS);
    return () => clearTimeout(timer);
  }, [statusQuery, statusQuery.data]);

  useEffect(() => {
    if (!activeLogin || activeLogin.flow.completion !== "poll" || environmentId === null) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const result = await pollAuth({
        environmentId,
        input: { loginId: activeLogin.flow.loginId },
      });
      if (cancelled || isAtomCommandInterrupted(result)) return;
      if (result._tag === "Failure") {
        setActiveLogin((current) =>
          current ? { ...current, error: commandError(result, t) } : current,
        );
        setBusyProvider(null);
        return;
      }
      if (settleLogin(result.value)) return;
      if (result.value.status === "pending") {
        timer = setTimeout(poll, Math.max(1000, result.value.nextPollMs));
      }
    };

    timer = setTimeout(poll, 1000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeLogin, environmentId, pollAuth, settleLogin, t]);

  const openApiKey = (definition: SubscriptionProviderDefinition) => {
    setError(null);
    setPastedCode("");
    setBaseUrl(
      providerSupportsBaseUrl(definition.id)
        ? (statusByProvider.get(definition.id)?.baseUrl ?? "")
        : "",
    );
    setKeyProvider(definition);
  };

  const saveApiKey = async () => {
    if (environmentId === null || !keyProvider || completing) return;
    const validationError = apiKeyValidationError(pastedCode, baseUrl);
    setError(validationError);
    if (validationError) return;
    setCompleting(true);
    const started = await startAuth({
      environmentId,
      input: apiKeyStartInput(keyProvider.id, baseUrl),
    });
    if (started._tag !== "Success") {
      setCompleting(false);
      if (started._tag === "Failure") setError(commandError(started, t));
      return;
    }
    const result = await completeAuth({
      environmentId,
      input: { loginId: started.value.loginId, code: pastedCode.trim() },
    });
    setCompleting(false);
    if (result._tag === "Success" && result.value.status === "connected") {
      setKeyProvider(null);
      setPastedCode("");
      setBaseUrl("");
      statusQuery.refresh();
    } else {
      if (result._tag === "Failure") setError(commandError(result, t));
      else if (result._tag === "Success")
        setError(
          result.value.status === "failed"
            ? result.value.error
            : t("The key was not saved. Try again."),
        );
      await cancelAuth({ environmentId, input: { loginId: started.value.loginId } });
    }
  };

  const connect = async (definition: SubscriptionProviderDefinition) => {
    if (environmentId === null) return;
    if (definition.id === "opencode-go") {
      openApiKey(definition);
      return;
    }
    setError(null);
    setPastedCode("");
    setBusyProvider(definition.id);
    const result = await startAuth({
      environmentId,
      input: { provider: definition.id },
    });
    if (isAtomCommandInterrupted(result)) return;
    if (result._tag === "Failure") {
      setError(commandError(result, t));
      setBusyProvider(null);
      return;
    }
    setActiveLogin({ flow: result.value, providerLabel: definition.label, error: null });
    window.open(result.value.url, "_blank", "noopener,noreferrer");
  };

  const complete = async () => {
    if (environmentId === null || !activeLogin) return;
    setCompleting(true);
    const result = await completeAuth({
      environmentId,
      input: { loginId: activeLogin.flow.loginId, code: pastedCode },
    });
    setCompleting(false);
    if (isAtomCommandInterrupted(result)) return;
    if (result._tag === "Failure") {
      setActiveLogin((current) =>
        current ? { ...current, error: commandError(result, t) } : current,
      );
      return;
    }
    settleLogin(result.value);
  };

  const cancelLogin = async () => {
    const login = activeLogin;
    setActiveLogin(null);
    setBusyProvider(null);
    setPastedCode("");
    if (environmentId === null || !login) return;
    const result = await cancelAuth({ environmentId, input: { loginId: login.flow.loginId } });
    if (result._tag === "Failure") setError(commandError(result, t));
  };

  const disconnect = async (provider: SubscriptionProviderId) => {
    if (environmentId === null) return;
    setError(null);
    setBusyProvider(provider);
    const result = await logoutAuth({ environmentId, input: { provider } });
    setBusyProvider(null);
    if (result._tag === "Success") statusQuery.refresh();
    else if (result._tag === "Failure") setError(commandError(result, t));
  };

  const testHealth = async (provider: SubscriptionProviderId) => {
    if (environmentId === null) return;
    setError(null);
    setBusyProvider(provider);
    const result = await testAuth({ environmentId, input: { provider } });
    setBusyProvider(null);
    if (result._tag === "Success") {
      statusQuery.refresh();
      const status = result.value.providers.find((entry) => entry.provider === provider);
      if (status?.oauthCheck?.status === "failed" || status?.healthTest?.status === "failed") {
        setError(
          status.lastFailedRequest?.message ??
            t("The provider check failed. Reconnect and try again."),
        );
      }
    } else if (result._tag === "Failure") setError(commandError(result, t));
  };

  if (keyProvider) {
    return (
      <SettingsPageContainer>
        <SettingsSection
          title={t("Connect {provider} with an API key", { provider: keyProvider.label })}
        >
          <ProviderApiKeyForm
            supportsBaseUrl={providerSupportsBaseUrl(keyProvider.id)}
            apiKey={pastedCode}
            baseUrl={baseUrl}
            busy={completing}
            error={error}
            onKeyChange={setPastedCode}
            onBaseUrlChange={setBaseUrl}
            onSave={() => void saveApiKey()}
            onCancel={() => {
              setKeyProvider(null);
              setPastedCode("");
              setBaseUrl("");
              setError(null);
            }}
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  if (activeLogin) {
    return (
      <SettingsPageContainer>
        <SettingsSection title={t("Connect {provider}", { provider: activeLogin.providerLabel })}>
          <ActiveLoginPanel
            login={activeLogin}
            pastedCode={pastedCode}
            onPastedCodeChange={setPastedCode}
            onComplete={() => void complete()}
            onCancel={() => void cancelLogin()}
            completing={completing}
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection title={t("Providers")}>
        <div className="px-3 pb-2 text-[13px] leading-[1.45] text-muted-foreground sm:px-4">
          {t("Connect a subscription or API key. Credentials stay on this environment.")}
        </div>

        {error || statusQuery.error ? (
          <div
            role="alert"
            className="mx-3 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive sm:mx-4"
          >
            {error ?? statusQuery.error}
          </div>
        ) : null}

        {SUBSCRIPTION_PROVIDERS.map((definition) => (
          <ProviderLoginCard
            key={definition.id}
            definition={definition}
            status={statusByProvider.get(definition.id)}
            models={providerAccessModelNames(serverProviders, definition.id)}
            busy={busyProvider === definition.id}
            disabled={busyProvider !== null || statusQuery.isPending}
            onApiKey={() => openApiKey(definition)}
            onConnect={() => void connect(definition)}
            onDisconnect={() => void disconnect(definition.id)}
            onTest={() => void testHealth(definition.id)}
          />
        ))}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
