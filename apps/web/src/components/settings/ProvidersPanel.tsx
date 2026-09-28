import { ExternalLinkIcon, LoaderIcon, LogOutIcon, RefreshCwIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import type {
  EnvironmentId,
  ProviderInstanceId,
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
  apiKeyStartInput,
  apiKeyValidationError,
  providerUsesApiKey,
  providerSupportsBaseUrl,
} from "@t3tools/client-runtime/provider-auth";

import { useAtomValue } from "@effect/atom-react";
import { providerAccessModelNames } from "@t3tools/client-runtime/provider-access";

import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ProviderAccessDetails } from "./ProviderAccessDetails";
import { accountConnectionState } from "./providerStatus";
import { SettingsMessageRow } from "./settingsDetailLayout";
import { SignInCodeCopy } from "./SignInCodeCopy";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import type { SubscriptionProviderDefinition } from "./subscriptionProviders";

export { SUBSCRIPTION_PROVIDERS } from "./subscriptionProviders";

interface ActiveLogin {
  readonly flow: SubscriptionAuthStartResult;
  readonly providerLabel: string;
  readonly error: string | null;
}

function commandError(result: AtomCommandResult<unknown, unknown>): string {
  if (result._tag !== "Failure") return "The request failed.";
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "The request failed.";
}

function joinNames(names: ReadonlyArray<string>): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

function disconnectDescription(status: SubscriptionProviderStatus | undefined): string {
  const bots = status?.dependentBots.map((bot) => bot.name) ?? [];
  if (bots.length === 0) return "Remove the saved credentials from this environment.";
  const shown = bots.length > 3 ? [...bots.slice(0, 3), `${bots.length - 3} more`] : bots;
  return `${joinNames(shown)} ${bots.length === 1 ? "uses" : "use"} this account.`;
}

function BusyIcon({ busy, idle }: { readonly busy: boolean; readonly idle?: ReactNode }) {
  if (busy) return <LoaderIcon className="size-3.5 animate-spin" />;
  return idle ?? null;
}

/**
 * The rows of a provider's Account section: how the environment signs in to
 * the provider, and the way back out. Each row has one primary action.
 */
export function ProviderAccountRows({
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
  /** Model names this environment serves for the provider, for the access guide. */
  readonly models?: ReadonlyArray<string>;
  readonly busy: boolean;
  readonly disabled?: boolean;
  readonly onConnect: () => void;
  readonly onDisconnect: () => void;
  readonly onTest: () => void;
  readonly onApiKey: () => void;
}) {
  const connected = status?.connected === true;
  const usesKey = connected && providerUsesApiKey(status);
  const keyOnly = definition.id === "opencode-go";
  const locked = busy || disabled;
  const attention = accountConnectionState(status, false);
  const problem = attention.tone === "attention" ? attention.detail : null;

  return (
    <>
      {connected ? (
        <SettingsRow
          title="Connected account"
          description={
            status.accountLabel ??
            (usesKey ? "API key saved on this environment" : "Account identity unavailable")
          }
        />
      ) : null}
      {keyOnly ? null : (
        <SettingsRow
          title="Subscription"
          description={definition.subscription}
          status={
            problem && !usesKey ? <span className="text-destructive">{problem}</span> : undefined
          }
          control={
            !connected ? (
              <Button size="xs" disabled={locked} onClick={onConnect}>
                <BusyIcon busy={busy} />
                Connect
              </Button>
            ) : usesKey ? (
              <Button size="xs" variant="outline" disabled={locked} onClick={onConnect}>
                Use OAuth
              </Button>
            ) : (
              <>
                <Button size="xs" variant="ghost-muted" disabled={locked} onClick={onConnect}>
                  Reconnect
                </Button>
                <Button size="xs" variant="outline" disabled={locked} onClick={onTest}>
                  <BusyIcon busy={busy} idle={<RefreshCwIcon className="size-3.5" />} />
                  Check
                </Button>
              </>
            )
          }
        />
      )}
      <SettingsRow
        title="API key"
        description={
          usesKey
            ? `Saved${status?.baseUrl ? ` · ${status.baseUrl}` : ""}`
            : keyOnly
              ? definition.description
              : "Pay per request instead of using the subscription."
        }
        status={
          problem && usesKey ? <span className="text-destructive">{problem}</span> : undefined
        }
        control={
          usesKey ? (
            <>
              <Button size="xs" variant="ghost-muted" disabled={locked} onClick={onApiKey}>
                Replace key
              </Button>
              <Button size="xs" variant="outline" disabled={locked} onClick={onTest}>
                <BusyIcon busy={busy} idle={<RefreshCwIcon className="size-3.5" />} />
                Check key
              </Button>
            </>
          ) : (
            <Button
              size="xs"
              variant={keyOnly && !connected ? "default" : "outline"}
              disabled={locked}
              onClick={onApiKey}
            >
              Add key
            </Button>
          )
        }
      />
      <SettingsRow
        title="Access"
        description={
          <ProviderAccessDetails
            provider={definition.id}
            status={status}
            models={models}
            showFailure={false}
          />
        }
      />
      {connected ? (
        <SettingsRow
          title="Disconnect"
          description={disconnectDescription(status)}
          control={
            <Button
              size="xs"
              variant="destructive-outline"
              aria-label={`Disconnect ${definition.label}`}
              disabled={locked}
              onClick={onDisconnect}
            >
              <LogOutIcon className="size-3.5" />
              Disconnect
            </Button>
          }
        />
      ) : null}
    </>
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
  return (
    <form
      className="space-y-3 px-3 pb-3 sm:px-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <label className="block space-y-1 text-sm">
        <span>API key</span>
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
          <span>Base URL (optional)</span>
          <Input
            type="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="Provider default"
            value={baseUrl}
            disabled={busy}
            onChange={(event) => onBaseUrlChange(event.currentTarget.value)}
          />
        </label>
      ) : null}
      <p className="text-[13px] text-muted-foreground">
        {supportsBaseUrl
          ? "The environment sends this key to the selected endpoint."
          : "Grok uses its default endpoint."}{" "}
        API billing can be separate from your subscription.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="xs" disabled={busy || !apiKey.trim()}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button type="button" size="xs" variant="ghost-muted" disabled={busy} onClick={onCancel}>
          Cancel
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
  const { flow } = login;
  const isApiKey = flow.provider === "opencode-go";
  return (
    <div data-settings-row="" className="space-y-3 rounded-xl px-3 py-3 sm:px-4">
      <p className="text-[13px] leading-[1.45] text-muted-foreground">
        {flow.userCode
          ? "Copy this code, then open the sign-in page and enter it."
          : (flow.instructions ?? `Finish signing in to ${login.providerLabel} in the browser.`)}
      </p>

      {/* The shared copy control falls back to manual copy on plain-HTTP remote clients. */}
      {flow.userCode ? <SignInCodeCopy code={flow.userCode} className="bg-muted/60" /> : null}

      <Button
        size="xs"
        variant="outline"
        render={<a href={flow.url} target="_blank" rel="noreferrer" />}
      >
        {isApiKey ? "Open OpenCode" : "Open sign-in page"}
        <ExternalLinkIcon className="size-3.5" />
      </Button>

      {flow.completion === "paste" ? (
        <div className="flex gap-2">
          <Input
            type={isApiKey ? "password" : "text"}
            autoComplete="off"
            value={pastedCode}
            onChange={(event) => onPastedCodeChange(event.currentTarget.value)}
            placeholder={isApiKey ? "Paste the API key" : "Paste the authorization code"}
            aria-label={isApiKey ? "API key" : "Authorization code"}
            className="flex-1"
          />
          <Button
            size="xs"
            disabled={pastedCode.trim().length === 0 || completing}
            onClick={onComplete}
          >
            {completing ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
            Connect
          </Button>
        </div>
      ) : !login.error ? (
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <LoaderIcon className="size-3.5 animate-spin" />
          Waiting for approval…
        </div>
      ) : null}

      {login.error ? (
        <p role="alert" className="text-[13px] text-destructive">
          {login.error}
        </p>
      ) : null}

      <Button size="xs" variant="ghost-muted" disabled={completing} onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

/** Subscription and API key status for every account on one environment. */
export function useSubscriptionStatuses(environmentId: EnvironmentId | null) {
  const statusQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.subscriptionAuth({ environmentId, input: {} }),
  );
  const statusByProvider = useMemo(
    () =>
      new Map<SubscriptionProviderId, SubscriptionProviderStatus>(
        statusQuery.data?.providers.map((status) => [status.provider, status]) ?? [],
      ),
    [statusQuery.data],
  );
  return { statusQuery, statusByProvider };
}

/** Sign-in, API key, check, and disconnect flows for subscription accounts. */
function useSubscriptionAccounts(
  environmentId: EnvironmentId | null,
  instanceId?: ProviderInstanceId,
) {
  const { statusQuery, statusByProvider } = useSubscriptionStatuses(environmentId);
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
          current ? { ...current, error: commandError(result) } : current,
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
  }, [activeLogin, environmentId, pollAuth, settleLogin]);

  const openApiKey = (definition: SubscriptionProviderDefinition) => {
    setError(null);
    setPastedCode("");
    setBaseUrl(
      providerSupportsBaseUrl(definition.id)
        ? ((instanceId
            ? statusQuery.data?.accounts.find(
                (entry) => entry.provider === definition.id && entry.instanceId === instanceId,
              )
            : statusByProvider.get(definition.id)
          )?.baseUrl ?? "")
        : "",
    );
    setKeyProvider(definition);
  };

  const closeApiKey = () => {
    setKeyProvider(null);
    setPastedCode("");
    setBaseUrl("");
    setError(null);
  };

  const saveApiKey = async () => {
    if (environmentId === null || !keyProvider || completing) return;
    const validationError = apiKeyValidationError(pastedCode, baseUrl);
    setError(validationError);
    if (validationError) return;
    setCompleting(true);
    const started = await startAuth({
      environmentId,
      input: {
        ...apiKeyStartInput(keyProvider.id, baseUrl),
        ...(instanceId ? { instanceId } : {}),
      },
    });
    if (started._tag !== "Success") {
      setCompleting(false);
      if (started._tag === "Failure") setError(commandError(started));
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
      if (result._tag === "Failure") setError(commandError(result));
      else if (result._tag === "Success")
        setError(
          result.value.status === "failed"
            ? result.value.error
            : "The key was not saved. Try again.",
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
      input: { provider: definition.id, ...(instanceId ? { instanceId } : {}) },
    });
    if (isAtomCommandInterrupted(result)) return;
    if (result._tag === "Failure") {
      setError(commandError(result));
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
        current ? { ...current, error: commandError(result) } : current,
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
    if (result._tag === "Failure") setError(commandError(result));
  };

  const disconnect = async (provider: SubscriptionProviderId) => {
    if (environmentId === null) return;
    setError(null);
    setBusyProvider(provider);
    const result = await logoutAuth({
      environmentId,
      input: { provider, ...(instanceId ? { instanceId } : {}) },
    });
    setBusyProvider(null);
    if (result._tag === "Success") statusQuery.refresh();
    else if (result._tag === "Failure") setError(commandError(result));
  };

  const testHealth = async (provider: SubscriptionProviderId) => {
    if (environmentId === null) return;
    setError(null);
    setBusyProvider(provider);
    const result = await testAuth({
      environmentId,
      input: { provider, ...(instanceId ? { instanceId } : {}) },
    });
    setBusyProvider(null);
    if (result._tag === "Success") {
      statusQuery.refresh();
      const status = (instanceId ? result.value.accounts : result.value.providers).find(
        (entry) => entry.provider === provider && (!instanceId || entry.instanceId === instanceId),
      );
      if (status?.oauthCheck?.status === "failed" || status?.healthTest?.status === "failed") {
        setError(
          status.lastFailedRequest?.message ??
            "The provider check failed. Reconnect and try again.",
        );
      }
    } else if (result._tag === "Failure") setError(commandError(result));
  };

  return {
    statusQuery,
    statusByProvider,
    activeLogin,
    busyProvider,
    pastedCode,
    setPastedCode,
    completing,
    error,
    keyProvider,
    baseUrl,
    setBaseUrl,
    openApiKey,
    closeApiKey,
    saveApiKey,
    connect,
    complete,
    cancelLogin,
    disconnect,
    testHealth,
  };
}

/**
 * Account section of a provider subpage. A running sign-in or API key form
 * replaces the rows until it finishes or the user cancels.
 */
export function ProviderAccountSection({
  environmentId,
  definition,
  instanceId,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly definition: SubscriptionProviderDefinition;
  readonly instanceId?: ProviderInstanceId;
}) {
  const accounts = useSubscriptionAccounts(environmentId, instanceId);
  const serverProviders = useAtomValue(serverEnvironment.configValueAtom(environmentId))?.providers;
  const status = instanceId
    ? accounts.statusQuery.data?.accounts.find(
        (entry) => entry.provider === definition.id && entry.instanceId === instanceId,
      )
    : accounts.statusByProvider.get(definition.id);
  const loadError = status ? null : accounts.statusQuery.error;

  let body: ReactNode;
  if (environmentId === null) {
    body = (
      <SettingsMessageRow>Connect to an environment to manage this account.</SettingsMessageRow>
    );
  } else if (accounts.keyProvider) {
    body = (
      <div data-settings-row="" className="rounded-xl pt-3">
        <h3 className="px-3 pb-3 text-sm font-medium text-foreground sm:px-4">
          {status?.connected && providerUsesApiKey(status) ? "Replace API key" : "Add API key"}
        </h3>
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
    );
  } else if (accounts.activeLogin) {
    body = (
      <ActiveLoginPanel
        login={accounts.activeLogin}
        pastedCode={accounts.pastedCode}
        onPastedCodeChange={accounts.setPastedCode}
        onComplete={() => void accounts.complete()}
        onCancel={() => void accounts.cancelLogin()}
        completing={accounts.completing}
      />
    );
  } else if (!status && accounts.statusQuery.isPending) {
    body = (
      <SettingsMessageRow>
        <span className="inline-flex items-center gap-2">
          <LoaderIcon className="size-3.5 animate-spin" />
          Checking account
        </span>
      </SettingsMessageRow>
    );
  } else {
    body = (
      <>
        {loadError ? (
          <SettingsMessageRow
            tone="error"
            action={
              <Button size="xs" variant="outline" onClick={() => accounts.statusQuery.refresh()}>
                Try again
              </Button>
            }
          >
            {loadError}
          </SettingsMessageRow>
        ) : null}
        {accounts.error ? (
          <SettingsMessageRow tone="error">{accounts.error}</SettingsMessageRow>
        ) : null}
        <ProviderAccountRows
          definition={definition}
          status={status}
          models={providerAccessModelNames(serverProviders, definition.id)}
          busy={accounts.busyProvider === definition.id}
          disabled={accounts.busyProvider !== null}
          onApiKey={() => accounts.openApiKey(definition)}
          onConnect={() => void accounts.connect(definition)}
          onDisconnect={() => void accounts.disconnect(definition.id)}
          onTest={() => void accounts.testHealth(definition.id)}
        />
      </>
    );
  }

  return (
    <SettingsSection
      id={instanceId ? `provider-account-${instanceId}` : "provider-account"}
      title={instanceId ? "Instance account" : "Account"}
    >
      {body}
    </SettingsSection>
  );
}
