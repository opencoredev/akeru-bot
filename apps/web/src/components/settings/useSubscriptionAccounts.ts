import { Predicate } from "effect";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  EnvironmentId,
  ProviderInstanceId,
  SubscriptionAuthLoginProgress,
  SubscriptionAuthStartResult,
  SubscriptionProviderId,
  SubscriptionProviderStatus,
} from "@akeru/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@akeru/client-runtime/state/runtime";
import {
  apiKeyStartInput,
  apiKeyValidationError,
  providerSupportsBaseUrl,
} from "@akeru/client-runtime/provider-auth";
import { useI18n } from "../../i18n";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import type { SubscriptionProviderDefinition } from "./subscriptionProviders";

type Translate = ReturnType<typeof useI18n>["t"];

export interface ActiveLogin {
  readonly flow: SubscriptionAuthStartResult;
  readonly providerLabel: string;
  readonly error: string | null;
}

function commandError(result: AtomCommandResult<unknown, unknown>, t: Translate): string {
  if (!Predicate.isTagged(result, "Failure")) return t("The request failed.");
  const error = squashAtomCommandFailure(result);

  return error instanceof Error ? error.message : t("The request failed.");
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
export function useSubscriptionAccounts(
  environmentId: EnvironmentId | null,
  instanceId?: ProviderInstanceId,
) {
  const { t } = useI18n();
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

      if (Predicate.isTagged(result, "Failure")) {
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

    if (!Predicate.isTagged(started, "Success")) {
      setCompleting(false);

      if (Predicate.isTagged(started, "Failure")) setError(commandError(started, t));

      return;
    }

    const result = await completeAuth({
      environmentId,
      input: { loginId: started.value.loginId, code: pastedCode.trim() },
    });

    setCompleting(false);

    if (Predicate.isTagged(result, "Success") && result.value.status === "connected") {
      setKeyProvider(null);
      setPastedCode("");
      setBaseUrl("");
      statusQuery.refresh();
    } else {
      if (Predicate.isTagged(result, "Failure")) setError(commandError(result, t));
      else if (Predicate.isTagged(result, "Success"))
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
      input: { provider: definition.id, ...(instanceId ? { instanceId } : {}) },
    });

    if (isAtomCommandInterrupted(result)) return;

    if (Predicate.isTagged(result, "Failure")) {
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

    if (Predicate.isTagged(result, "Failure")) {
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

    if (Predicate.isTagged(result, "Failure")) setError(commandError(result, t));
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

    if (Predicate.isTagged(result, "Success")) statusQuery.refresh();
    else if (Predicate.isTagged(result, "Failure")) setError(commandError(result, t));
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

    if (Predicate.isTagged(result, "Success")) {
      statusQuery.refresh();

      const status = (instanceId ? result.value.accounts : result.value.providers).find(
        (entry) => entry.provider === provider && (!instanceId || entry.instanceId === instanceId),
      );

      if (status?.oauthCheck?.status === "failed" || status?.healthTest?.status === "failed") {
        setError(
          status.lastFailedRequest?.message ??
            t("The provider check failed. Reconnect and try again."),
        );
      }
    } else if (Predicate.isTagged(result, "Failure")) setError(commandError(result, t));
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
