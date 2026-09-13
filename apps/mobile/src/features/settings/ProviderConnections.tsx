import { useCallback, useEffect, useState } from "react";
import { Linking, Pressable, TextInput, View } from "react-native";
import type {
  EnvironmentId,
  SubscriptionAuthLoginProgress,
  SubscriptionAuthStartResult,
  SubscriptionProviderId,
} from "@t3tools/contracts";
import {
  apiKeyStartInput,
  apiKeyValidationError,
  PROVIDER_CONNECTIONS,
  providerConnectionLabel,
  providerUsesApiKey,
  providerSupportsBaseUrl,
} from "@t3tools/client-runtime/provider-auth";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

import { AppText as Text } from "../../components/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

const RETRY_POLL_MS = 5000;

function commandError(result: AtomCommandResult<unknown, unknown>): string {
  if (result._tag !== "Failure") return "The request failed.";
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "The request failed.";
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
  const query = useEnvironmentQuery(
    serverEnvironment.subscriptionAuth({ environmentId, input: {} }),
  );
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
  const [code, setCode] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const settle = useCallback(
    (progress: SubscriptionAuthLoginProgress) => {
      if (progress.status === "connected") {
        setFlow(null);
        setCode("");
        query.refresh();
        return true;
      }
      if (progress.status === "failed") setError(progress.error);
      return progress.status !== "pending";
    },
    [query],
  );

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
          setError(commandError(result));
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
      setError("Could not open the sign-in page. Try Open sign-in again.");
    }
  };

  const openKey = (provider: SubscriptionProviderId) => {
    setError(null);
    setCode("");
    setBaseUrl(
      providerSupportsBaseUrl(provider)
        ? (query.data?.providers.find((status) => status.provider === provider)?.baseUrl ?? "")
        : "",
    );
    setKeyProvider(provider);
  };

  const connect = async (provider: SubscriptionProviderId) => {
    if (provider === "opencode-go") {
      openKey(provider);
      return;
    }
    setError(null);
    setCode("");
    setBusy(true);
    const result = await start({ environmentId, input: { provider } });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(commandError(result));
      return;
    }
    if (result._tag !== "Success") return;
    setFlow(result.value);
    if (result.value.url) await openUrl(result.value.url);
  };

  const saveKey = async () => {
    if (!keyProvider || busy) return;
    const validation = apiKeyValidationError(code, baseUrl);
    setError(validation);
    if (validation) return;
    setBusy(true);
    const started = await start({ environmentId, input: apiKeyStartInput(keyProvider, baseUrl) });
    if (started._tag !== "Success") {
      setBusy(false);
      if (started._tag === "Failure") setError(commandError(started));
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
      query.refresh();
    } else {
      if (result._tag === "Failure") setError(commandError(result));
      else if (result._tag === "Success")
        setError(
          result.value.status === "failed"
            ? result.value.error
            : "The key was not saved. Try again.",
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
    else if (result._tag === "Failure") setError(commandError(result));
  };

  const cancelLogin = async () => {
    const login = flow;
    setFlow(null);
    setKeyProvider(null);
    setCode("");
    setBaseUrl("");
    setError(null);
    if (login) {
      const result = await cancel({ environmentId, input: { loginId: login.loginId } });
      if (result._tag === "Failure") setError(commandError(result));
    }
  };

  const runAction = async (provider: SubscriptionProviderId, action: "disconnect" | "test") => {
    setError(null);
    setBusy(true);
    const result = await (action === "disconnect" ? logout : test)({
      environmentId,
      input: { provider },
    });
    setBusy(false);
    if (result._tag === "Success") query.refresh();
    else if (result._tag === "Failure") setError(commandError(result));
  };

  const activeProvider = keyProvider ?? flow?.provider;
  const label = PROVIDER_CONNECTIONS.find((provider) => provider.id === activeProvider)?.label;
  return (
    <SettingsSection title={activeProvider ? `Connect ${label}` : "Provider connections"} card>
      <View className="gap-3 p-4">
        {error || query.error ? (
          <Text accessibilityRole="alert" className="text-sm text-danger">
            {error ?? query.error}
          </Text>
        ) : null}
        {keyProvider ? (
          <>
            <Text className="text-sm font-t3-medium text-foreground">API key</Text>
            <TextInput
              accessibilityLabel="API key"
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
                <Text className="text-sm font-t3-medium text-foreground">Base URL (optional)</Text>
                <TextInput
                  accessibilityLabel="Base URL (optional)"
                  placeholder="Provider default"
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
                ? "The environment sends this key to the selected endpoint."
                : "Grok uses its default endpoint."}{" "}
              API billing can be separate from your subscription.
            </Text>
            <View className="flex-row gap-2">
              <Action
                label={busy ? "Saving…" : "Save"}
                disabled={busy || !code.trim()}
                onPress={() => void saveKey()}
              />
              <Action label="Cancel" disabled={busy} onPress={() => void cancelLogin()} />
            </View>
          </>
        ) : flow ? (
          <>
            {flow.instructions ? (
              <Text className="text-sm text-foreground-muted">{flow.instructions}</Text>
            ) : null}
            {flow.url ? (
              <Action label="Open sign-in" onPress={() => void openUrl(flow.url)} />
            ) : null}
            {flow.userCode ? (
              <Text selectable className="text-lg font-t3-medium text-foreground">
                {flow.userCode}
              </Text>
            ) : null}
            {flow.completion === "paste" ? (
              <>
                <TextInput
                  accessibilityLabel="Authorization code"
                  placeholder="Paste the authorization code"
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={code}
                  editable={!busy}
                  onChangeText={setCode}
                  className="min-h-11 rounded-xl border border-border-subtle px-3 py-2 text-foreground"
                />
                <Action
                  label="Connect"
                  disabled={busy || !code.trim()}
                  onPress={() => void finish()}
                />
              </>
            ) : !error ? (
              <Text className="text-sm text-foreground-muted">Waiting for approval…</Text>
            ) : null}
            <Action label="Cancel" disabled={busy} onPress={() => void cancelLogin()} />
          </>
        ) : (
          <>
            {query.isPending ? (
              <Text className="text-sm text-foreground-muted">Loading connections…</Text>
            ) : null}
            {PROVIDER_CONNECTIONS.map((provider) => {
              const status = query.data?.providers.find((entry) => entry.provider === provider.id);
              const apiKey = providerUsesApiKey(status);
              return (
                <View key={provider.id} className="gap-2 border-b border-border-subtle py-3">
                  <Text className="text-base font-t3-medium text-foreground">{provider.label}</Text>
                  <Text className="text-sm text-foreground-muted">
                    {status ? providerConnectionLabel(status) : "Status unavailable"}
                  </Text>
                  {status?.baseUrl ? (
                    <Text selectable className="text-sm text-foreground-muted">
                      {status.baseUrl}
                    </Text>
                  ) : null}
                  {status?.lastFailedRequest ? (
                    <Text className="text-sm text-danger">{status.lastFailedRequest.message}</Text>
                  ) : null}
                  <View className="flex-row flex-wrap gap-2">
                    <Action
                      label={
                        status?.connected
                          ? apiKey && provider.id !== "opencode-go"
                            ? "Use OAuth"
                            : "Reconnect"
                          : "Connect"
                      }
                      disabled={busy || query.isPending}
                      onPress={() => void connect(provider.id)}
                    />
                    {provider.id !== "opencode-go" ? (
                      <Action
                        label={apiKey ? "Reconnect key" : "API key"}
                        disabled={busy || query.isPending}
                        onPress={() => openKey(provider.id)}
                      />
                    ) : null}
                    {status?.connected ? (
                      <>
                        <Action
                          label={apiKey ? "Check key" : "Check OAuth"}
                          disabled={busy}
                          onPress={() => void runAction(provider.id, "test")}
                        />
                        <Action
                          label="Disconnect"
                          disabled={busy}
                          onPress={() => void runAction(provider.id, "disconnect")}
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
