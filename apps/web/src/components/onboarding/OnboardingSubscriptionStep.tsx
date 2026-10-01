import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@akeru/client-runtime/state/runtime";
import {
  apiKeyStartInput,
  apiKeyValidationError,
  providerSupportsBaseUrl,
} from "@akeru/client-runtime/provider-auth";
import type {
  EnvironmentId,
  SubscriptionAuthLoginProgress,
  SubscriptionAuthStartResult,
} from "@akeru/contracts";
import { ArrowRightIcon, CheckIcon, ExternalLinkIcon, LoaderIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useI18n } from "../../i18n";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ProviderApiKeyForm } from "../settings/ProvidersPanel";
import { SignInCodeCopy } from "../settings/SignInCodeCopy";
import { SUBSCRIPTION_PROVIDERS } from "../settings/subscriptionProviders";
import type { DesktopOnboardingDraft } from "./desktopOnboardingDraft";
import { ONBOARDING_HEADING_CLASS } from "./onboardingStyles";
import type { OnboardingTranslate } from "./onboardingTranslate";

function commandError(
  result: Parameters<typeof squashAtomCommandFailure>[0],
  t: OnboardingTranslate,
): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : t("The request failed.");
}

interface ActiveLogin {
  readonly flow: SubscriptionAuthStartResult;
  readonly error: string | null;
}

export function SubscriptionStep({
  environmentId,
  draft,
  captureMode = false,
  onChange,
  onContinue,
}: {
  readonly environmentId: EnvironmentId;
  readonly draft: DesktopOnboardingDraft;
  readonly captureMode?: boolean;
  readonly onChange: (draft: DesktopOnboardingDraft) => void;
  readonly onContinue: () => void;
}) {
  const statusQuery = useEnvironmentQuery(
    serverEnvironment.subscriptionAuth({ environmentId, input: {} }),
  );
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
  const { t } = useI18n();
  const [activeLogin, setActiveLogin] = useState<ActiveLogin | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [keyMode, setKeyMode] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  const statusByProvider = useMemo(
    () => new Map(statusQuery.data?.providers.map((status) => [status.provider, status]) ?? []),
    [statusQuery.data],
  );
  const selected = SUBSCRIPTION_PROVIDERS.find((item) => item.id === draft.providerId)!;
  const connected = captureMode || statusByProvider.get(draft.providerId)?.connected === true;

  const settle = useCallback(
    (progress: SubscriptionAuthLoginProgress) => {
      if (progress.status === "connected") {
        setActiveLogin(null);
        setBusy(false);
        statusQuery.refresh();
        return true;
      }
      if (progress.status === "failed") {
        setActiveLogin((current) => (current ? { ...current, error: progress.error } : current));
        setBusy(false);
      }
      return false;
    },
    [statusQuery],
  );

  useEffect(() => {
    if (!activeLogin || activeLogin.flow.completion !== "poll") return;
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
        setBusy(false);
        return;
      }
      if (settle(result.value)) return;
      if (result.value.status === "pending") {
        timer = setTimeout(poll, Math.max(1_000, result.value.nextPollMs));
      }
    };
    timer = setTimeout(poll, 1_000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeLogin, environmentId, pollAuth, settle, t]);

  const openKey = () => {
    setCode("");
    setError(null);
    setBaseUrl(statusByProvider.get(draft.providerId)?.baseUrl ?? "");
    setKeyMode(true);
  };

  const saveKey = async () => {
    if (busy) return;
    const validation = apiKeyValidationError(code, baseUrl);
    setError(validation);
    if (validation) return;
    setBusy(true);
    const started = await startAuth({
      environmentId,
      input: apiKeyStartInput(draft.providerId, baseUrl),
    });
    if (started._tag !== "Success") {
      setBusy(false);
      if (started._tag === "Failure") setError(commandError(started, t));
      return;
    }
    const result = await completeAuth({
      environmentId,
      input: { loginId: started.value.loginId, code: code.trim() },
    });
    if (result._tag === "Success" && result.value.status === "connected") {
      setCode("");
      setBaseUrl("");
      setKeyMode(false);
      setBusy(false);
      statusQuery.refresh();
      onContinue();
      return;
    }
    if (result._tag === "Failure") setError(commandError(result, t));
    else if (result._tag === "Success") {
      setError(
        result.value.status === "failed"
          ? result.value.error
          : t("The key was not saved. Try again."),
      );
    }
    await cancelAuth({ environmentId, input: { loginId: started.value.loginId } });
    setBusy(false);
  };

  const connect = async () => {
    if (draft.providerId === "opencode-go" && !captureMode) {
      openKey();
      return;
    }
    if (captureMode) {
      onContinue();
      return;
    }
    setError(null);
    setCode("");
    setBusy(true);
    const result = await startAuth({
      environmentId,
      input: { provider: draft.providerId },
    });
    if (isAtomCommandInterrupted(result)) {
      setBusy(false);
      return;
    }
    if (result._tag === "Failure") {
      setError(commandError(result, t));
      setBusy(false);
      return;
    }
    setBusy(false);
    setActiveLogin({ flow: result.value, error: null });
    window.open(result.value.url, "_blank", "noopener,noreferrer");
  };

  const complete = async () => {
    if (!activeLogin) return;
    setBusy(true);
    const result = await completeAuth({
      environmentId,
      input: { loginId: activeLogin.flow.loginId, code },
    });
    if (isAtomCommandInterrupted(result)) {
      setBusy(false);
      return;
    }
    if (result._tag === "Failure") {
      setActiveLogin((current) =>
        current ? { ...current, error: commandError(result, t) } : current,
      );
      setBusy(false);
      return;
    }
    settle(result.value);
  };

  const cancel = async () => {
    const login = activeLogin;
    setActiveLogin(null);
    setBusy(false);
    setCode("");
    if (login) {
      await cancelAuth({ environmentId, input: { loginId: login.flow.loginId } });
    }
  };

  if (keyMode) {
    return (
      <div className="space-y-4">
        <h1 className={ONBOARDING_HEADING_CLASS}>
          {t("Connect {provider} with an API key", { provider: selected.label })}
        </h1>
        <ProviderApiKeyForm
          supportsBaseUrl={providerSupportsBaseUrl(draft.providerId)}
          apiKey={code}
          baseUrl={baseUrl}
          busy={busy}
          error={error}
          onKeyChange={setCode}
          onBaseUrlChange={setBaseUrl}
          onSave={() => void saveKey()}
          onCancel={() => {
            setKeyMode(false);
            setCode("");
            setBaseUrl("");
            setError(null);
          }}
        />
      </div>
    );
  }

  if (activeLogin) {
    return (
      <div className="space-y-4">
        <h1 className={ONBOARDING_HEADING_CLASS}>
          {t("Finish connecting {provider}", { provider: selected.label })}
        </h1>
        <p className="text-sm leading-6 text-muted-foreground">
          {activeLogin.flow.instructions ?? t("Finish signing in on the provider page.")}
        </p>
        {activeLogin.flow.userCode ? (
          <SignInCodeCopy
            code={activeLogin.flow.userCode}
            className="rounded-xl border border-border/70 bg-background/60 py-2.5"
          />
        ) : null}
        {activeLogin.flow.completion === "paste" ? (
          <div className="space-y-2">
            <Input
              value={code}
              onChange={(event) => setCode(event.currentTarget.value)}
              placeholder={t("Paste authorization code")}
              aria-label={t("Authorization code")}
            />
            <Button
              className="w-full"
              disabled={!code.trim() || busy}
              onClick={() => void complete()}
            >
              {busy ? (
                <LoaderIcon className="size-4 animate-spin motion-reduce:animate-none" />
              ) : null}
              {t("Connect")}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderIcon className="size-4 animate-spin motion-reduce:animate-none" />
            {t("Waiting for approval")}
          </div>
        )}
        {activeLogin.error ? <p className="text-sm text-destructive">{activeLogin.error}</p> : null}
        <div className="flex gap-2">
          <Button
            className="flex-1"
            variant="outline"
            render={<a href={activeLogin.flow.url} target="_blank" rel="noreferrer" />}
          >
            {t("Open sign-in")} <ExternalLinkIcon className="size-4" />
          </Button>
          <Button variant="ghost-muted" onClick={() => void cancel()}>
            {t("Cancel")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className={ONBOARDING_HEADING_CLASS}>{t("Connect your provider")}</h1>
      </div>
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t("Provider")}>
        {SUBSCRIPTION_PROVIDERS.map((definition) => {
          const active = definition.id === draft.providerId;
          const ProviderIcon = typeof definition.icon === "string" ? null : definition.icon;
          const providerConnected = captureMode
            ? active
            : statusByProvider.get(definition.id)?.connected === true;
          return (
            <button
              key={definition.id}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={busy}
              onClick={() => onChange({ ...draft, providerId: definition.id })}
              className={`relative flex min-h-24 flex-col items-start rounded-2xl border p-3 text-left transition duration-150 motion-reduce:transition-none ${
                active
                  ? "border-foreground/30 bg-foreground/[0.06] shadow-sm"
                  : "border-border/65 bg-background/35 hover:bg-foreground/[0.035]"
              }`}
            >
              <div className="flex w-full items-center justify-between">
                <span className="flex size-8 items-center justify-center rounded-lg border border-border/60 bg-background/70">
                  {ProviderIcon ? (
                    <ProviderIcon className="size-4" />
                  ) : (
                    <img
                      src={definition.icon as string}
                      alt=""
                      className="size-4 brightness-0 dark:invert"
                    />
                  )}
                </span>
                {providerConnected ? (
                  <span className="flex size-5 items-center justify-center rounded-full bg-success/15 text-success-foreground">
                    <CheckIcon className="size-3" />
                  </span>
                ) : null}
              </div>
              <span className="mt-2 text-sm font-medium">{definition.label}</span>
              <span className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                {t(definition.subscription)}
              </span>
            </button>
          );
        })}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {!connected && selected.id !== "opencode-go" ? (
        <Button className="w-full" variant="outline" disabled={busy} onClick={openKey}>
          {t("Use an API key")}
        </Button>
      ) : null}
      <Button
        size="onboarding"
        className="w-full"
        disabled={busy}
        onClick={connected ? onContinue : () => void connect()}
      >
        {busy ? <LoaderIcon className="size-4 animate-spin motion-reduce:animate-none" /> : null}
        {connected ? t("Continue") : t("Connect {provider}", { provider: selected.label })}
        {!busy ? <ArrowRightIcon className="size-4" /> : null}
      </Button>
    </div>
  );
}
