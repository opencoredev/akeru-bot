import { useAtomValue } from "@effect/atom-react";
import { useMobileI18n } from "../../lib/i18n";
import { useCallback, useEffect, useState } from "react";
import { Linking, Pressable, TextInput, View } from "react-native";
import type {
  EnvironmentId,
  ProviderInstanceId,
  SubscriptionAuthLoginProgress,
  SubscriptionAuthStartResult,
  SubscriptionProviderId,
} from "@t3tools/contracts";
import {
  anyProviderHealthChecking,
  apiKeyStartInput,
  apiKeyValidationError,
  HEALTH_CHECK_REFRESH_MS,
  PROVIDER_CONNECTIONS,
  providerConnectionLabel,
  providerUsesApiKey,
  providerSupportsBaseUrl,
} from "@t3tools/client-runtime/provider-auth";
import { providerAccessModelNames } from "@t3tools/client-runtime/provider-access";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

import { AppText as Text } from "../../components/AppText";
import { ProviderAccessSummary } from "./ProviderAccessSummary";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { copySignInCode } from "./copySignInCode";

const RETRY_POLL_MS = 5000;

function commandError(
  result: AtomCommandResult<unknown, unknown>,
  t: (message: string) => string,
): string {
  if (result._tag !== "Failure") return t("The request failed.");
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : t("The request failed.");
}

function Action({
  label,
  disabled = false,
  onPress,
}: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`min-h-11 justify-center rounded-xl bg-subtle px-3 py-2 ${disabled ? "opacity-50" : ""}`}
    >
      <Text className="text-sm font-t3-medium text-foreground">{label}</Text>
    </Pressable>
  );
}

export function ProviderConnections({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { t } = useMobileI18n();
  const query = useEnvironmentQuery(
    serverEnvironment.subscriptionAuth({ environmentId, input: {} }),
  );
  const serverProviders = useAtomValue(serverEnvironment.configValueAtom(environmentId))?.providers;
  const start = useAtomCommand(serverEnvironment.startSubscriptionAuth, { reportFailure: false });
  const complete = useAtomCommand(serverEnvironment.completeSubscriptionAuth, {
    reportFailure: false,
  });
  const poll = useAtomCommand(serverEnvironment.pollSubscriptionAuth, { reportFailure: false });
  const cancel = useAtomCommand(serverEnvironment.cancelSubscriptionAuth, { reportFailure: false });
  const logout = useAtomCommand(serverEnvironment.logoutSubscriptionAuth, { reportFailure: false });
  const test = useAtomCommand(serverEnvironment.testSubscriptionAuth, { reportFailure: false });
  const [flow, setFlow] = useState<SubscriptionAuthStartResult | null>(null);
  const [keyProvider, setKeyProvider] = useState<SubscriptionProviderId | null>(null);
  const [activeInstanceId, setActiveInstanceId] = useState<ProviderInstanceId | undefined>();
  const [code, setCode] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  const settle = useCallback(
    (progress: SubscriptionAuthLoginProgress) => {
      if (progress.status === "connected") {
        setFlow(null);
        setCode("");
        setActiveInstanceId(undefined);
        query.refresh();
        return true;
      }
      if (progress.status === "failed") setError(progress.error);
      return progress.status !== "pending";
    },
    [query],
  );

  // The server checks health right after a login stores credentials. Refresh until
  // that check lands so the row does not stay on "Checking health…".
  useEffect(() => {
    if (!anyProviderHealthChecking(query.data?.providers)) return;
    const timer = setTimeout(() => query.refresh(), HEALTH_CHECK_REFRESH_MS);
    return () => clearTimeout(timer);
  }, [query, query.data]);

  useEffect(() => {
    if (!flow || flow.completion !== "poll") return;
    let cancelled = false;
    let pollFailed = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      const result = await poll({ environmentId, input: { loginId: flow.loginId } });
      if (cancelled) return;
      if (result._tag !== "Success") {
        // A dropped request must not end the login; the next check picks up the approval.
        if (result._tag === "Failure") {
          pollFailed = true;
          setError(commandError(result, t));
        }
        timer = setTimeout(check, RETRY_POLL_MS);
        return;
      }
      if (pollFailed) {
        pollFailed = false;
        setError(null);
      }
      if (settle(result.value)) return;
      if (result.value.status === "pending")
        timer = setTimeout(check, Math.max(1000, result.value.nextPollMs));
    };
    timer = setTimeout(check, 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [flow, environmentId, poll, settle]);

  const openUrl = async (url: string) => {
    try {
      await Linking.openURL(url);
    } catch {
      setError(t("Could not open the sign-in page. Try Open sign-in again."));
    }
  };

  const openKey = (provider: SubscriptionProviderId, instanceId?: ProviderInstanceId) => {
    setError(null);
    setCode("");
    setActiveInstanceId(instanceId);
    setBaseUrl(
      providerSupportsBaseUrl(provider)
        ? ((instanceId
            ? query.data?.accounts.find(
                (status) => status.provider === provider && status.instanceId === instanceId,
              )
            : query.data?.providers.find((status) => status.provider === provider)
          )?.baseUrl ?? "")
        : "",
    );
    setKeyProvider(provider);
  };

  const connect = async (provider: SubscriptionProviderId, instanceId?: ProviderInstanceId) => {
    if (provider === "opencode-go") {
      openKey(provider, instanceId);
      return;
    }
    setError(null);
    setCode("");
    setActiveInstanceId(instanceId);
    setBusy(true);
    const result = await start({
      environmentId,
      input: { provider, ...(instanceId ? { instanceId } : {}) },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(commandError(result, t));
      return;
    }
    if (result._tag !== "Success") return;
    setCopyState("idle");
    setFlow(result.value);
    if (result.value.url) await openUrl(result.value.url);
  };

  const saveKey = async () => {
    if (!keyProvider || busy) return;
    const validation = apiKeyValidationError(code, baseUrl);
    setError(validation);
    if (validation) return;
    setBusy(true);
    const started = await start({
      environmentId,
      input: {
        ...apiKeyStartInput(keyProvider, baseUrl),
        ...(activeInstanceId ? { instanceId: activeInstanceId } : {}),
      },
    });
    if (started._tag !== "Success") {
      setBusy(false);
      if (started._tag === "Failure") setError(commandError(started, t));
      return;
    }
    const result = await complete({
      environmentId,
      input: { loginId: started.value.loginId, code: code.trim() },
    });
    setBusy(false);
    if (result._tag === "Success" && result.value.status === "connected") {
      setKeyProvider(null);
      setCode("");
      setBaseUrl("");
      setActiveInstanceId(undefined);
      query.refresh();
    } else {
      if (result._tag === "Failure") setError(commandError(result, t));
      else if (result._tag === "Success")
        setError(
          result.value.status === "failed"
            ? result.value.error
            : t("The key was not saved. Try again."),
        );
      await cancel({ environmentId, input: { loginId: started.value.loginId } });
    }
  };

  const finish = async () => {
    if (!flow || busy) return;
    setError(null);
    setBusy(true);
    const result = await complete({ environmentId, input: { loginId: flow.loginId, code } });
    setBusy(false);
    if (result._tag === "Success") settle(result.value);
    else if (result._tag === "Failure") setError(commandError(result, t));
  };

  const cancelLogin = async () => {
    const login = flow;
    setFlow(null);
    setKeyProvider(null);
    setCode("");
    setBaseUrl("");
    setActiveInstanceId(undefined);
    setError(null);
    if (login) {
      const result = await cancel({ environmentId, input: { loginId: login.loginId } });
      if (result._tag === "Failure") setError(commandError(result, t));
    }
  };

  const runAction = async (
    provider: SubscriptionProviderId,
    action: "disconnect" | "test",
    instanceId?: ProviderInstanceId,
  ) => {
    setError(null);
    setBusy(true);
    const result = await (action === "disconnect" ? logout : test)({
      environmentId,
      input: { provider, ...(instanceId ? { instanceId } : {}) },
    });
    setBusy(false);
    if (result._tag === "Success") query.refresh();
    else if (result._tag === "Failure") setError(commandError(result, t));
  };

  const activeProvider = keyProvider ?? flow?.provider;
  const label = PROVIDER_CONNECTIONS.find((provider) => provider.id === activeProvider)?.label;
  return (
    <SettingsSection
      title={
        activeProvider
          ? t("Connect {provider}", { provider: label ?? "" })
          : t("Provider connections")
      }
      card
    >
      <View className="gap-3 p-4">
        {error || query.error ? (
          <Text accessibilityRole="alert" className="text-sm text-danger">
            {error ?? query.error}
          </Text>
        ) : null}
        {keyProvider ? (
          <>
            <Text className="text-sm font-t3-medium text-foreground">{t("API key")}</Text>
            <TextInput
              accessibilityLabel={t("API key")}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              value={code}
              editable={!busy}
              onChangeText={setCode}
              className="min-h-11 rounded-xl border border-border-subtle px-3 py-2 text-foreground"
            />
            {providerSupportsBaseUrl(keyProvider) ? (
              <>
                <Text className="text-sm font-t3-medium text-foreground">
                  {t("Base URL (optional)")}
                </Text>
                <TextInput
                  accessibilityLabel={t("Base URL (optional)")}
                  placeholder={t("Provider default")}
                  keyboardType="url"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  value={baseUrl}
                  editable={!busy}
                  onChangeText={setBaseUrl}
                  className="min-h-11 rounded-xl border border-border-subtle px-3 py-2 text-foreground"
                />
              </>
            ) : null}
            <Text className="text-sm text-foreground-muted">
              {providerSupportsBaseUrl(keyProvider)
                ? t("The environment sends this key to the selected endpoint.")
                : t("Grok uses its default endpoint.")}{" "}
              {t("API billing can be separate from your subscription.")}
            </Text>
            <View className="flex-row gap-2">
              <Action
                label={busy ? t("Saving…") : t("Save")}
                disabled={busy || !code.trim()}
                onPress={() => void saveKey()}
              />
              <Action label={t("Cancel")} disabled={busy} onPress={() => void cancelLogin()} />
            </View>
          </>
        ) : flow ? (
          <>
            {flow.instructions ? (
              <Text className="text-sm text-foreground-muted">{flow.instructions}</Text>
            ) : null}
            {flow.url ? (
              <Action label={t("Open sign-in")} onPress={() => void openUrl(flow.url)} />
            ) : null}
            {flow.userCode ? (
              <>
                <Text selectable className="text-lg font-t3-medium text-foreground">
                  {flow.userCode}
                </Text>
                <Action
                  label={copyState === "copied" ? t("Code copied") : t("Copy code")}
                  onPress={() => {
                    const userCode = flow.userCode;
                    if (!userCode) return;
                    void copySignInCode(userCode).then((copied) =>
                      setCopyState(copied ? "copied" : "failed"),
                    );
                  }}
                />
                {copyState === "failed" ? (
                  <Text accessibilityRole="alert" className="text-sm text-foreground-muted">
                    {t("Couldn't copy the code. Select it and copy it manually.")}
                  </Text>
                ) : null}
              </>
            ) : null}
            {flow.completion === "paste" ? (
              <>
                <TextInput
                  accessibilityLabel={t("Authorization code")}
                  placeholder={t("Paste the authorization code")}
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={code}
                  editable={!busy}
                  onChangeText={setCode}
                  className="min-h-11 rounded-xl border border-border-subtle px-3 py-2 text-foreground"
                />
                <Action
                  label={t("Connect")}
                  disabled={busy || !code.trim()}
                  onPress={() => void finish()}
                />
              </>
            ) : !error ? (
              <Text className="text-sm text-foreground-muted">{t("Waiting for approval…")}</Text>
            ) : null}
            <Action label={t("Cancel")} disabled={busy} onPress={() => void cancelLogin()} />
          </>
        ) : (
          <>
            {query.isPending ? (
              <Text className="text-sm text-foreground-muted">{t("Loading connections…")}</Text>
            ) : null}
            {PROVIDER_CONNECTIONS.flatMap((provider) => [
              {
                provider,
                status: query.data?.providers.find((entry) => entry.provider === provider.id),
                instanceId: undefined as ProviderInstanceId | undefined,
              },
              ...(query.data?.accounts
                .filter((entry) => entry.provider === provider.id)
                .map((status) => ({ provider, status, instanceId: status.instanceId })) ?? []),
            ]).map(({ provider, status, instanceId }) => {
              const apiKey = providerUsesApiKey(status);
              return (
                <View
                  key={`${provider.id}:${instanceId ?? "default"}`}
                  className="gap-2 border-b border-border-subtle py-3"
                >
                  <Text className="text-base font-t3-medium text-foreground">
                    {provider.label}
                    {instanceId ? ` · ${instanceId}` : ""}
                  </Text>
                  <Text className="text-sm text-foreground-muted">
                    {status ? t(providerConnectionLabel(status)) : t("Status unavailable")}
                  </Text>
                  {status?.baseUrl ? (
                    <Text selectable className="text-sm text-foreground-muted">
                      {status.baseUrl}
                    </Text>
                  ) : null}
                  <ProviderAccessSummary
                    provider={provider.id}
                    status={status}
                    models={providerAccessModelNames(serverProviders, provider.id)}
                  />
                  <View className="flex-row flex-wrap gap-2">
                    <Action
                      label={
                        status?.connected
                          ? apiKey && provider.id !== "opencode-go"
                            ? t("Use OAuth")
                            : t("Reconnect")
                          : t("Connect")
                      }
                      disabled={busy || query.isPending}
                      onPress={() => void connect(provider.id, instanceId)}
                    />
                    {provider.id !== "opencode-go" ? (
                      <Action
                        label={apiKey ? t("Reconnect key") : t("API key")}
                        disabled={busy || query.isPending}
                        onPress={() => openKey(provider.id, instanceId)}
                      />
                    ) : null}
                    {status?.connected ? (
                      <>
                        <Action
                          label={apiKey ? t("Check key") : t("Check OAuth")}
                          disabled={busy}
                          onPress={() => void runAction(provider.id, "test", instanceId)}
                        />
                        <Action
                          label={t("Disconnect")}
                          disabled={busy}
                          onPress={() => void runAction(provider.id, "disconnect", instanceId)}
                        />
                      </>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </>
        )}
      </View>
    </SettingsSection>
  );
}
