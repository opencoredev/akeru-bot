import { CopyIcon, ExternalLinkIcon, LoaderIcon, LogOutIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
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

import { useSettingsEnvironmentId } from "../../settingsDialogStore";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ClaudeAI, type Icon } from "../Icons";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

interface SubscriptionProviderDefinition {
  readonly id: SubscriptionProviderId;
  readonly label: string;
  readonly subscription: string;
  readonly description: string;
  readonly icon: Icon | string;
}

export const SUBSCRIPTION_PROVIDERS: readonly SubscriptionProviderDefinition[] = [
  {
    id: "openai-codex",
    label: "ChatGPT",
    subscription: "Plus, Pro, Business, Enterprise, or Edu",
    description: "Use your ChatGPT subscription with Codex models.",
    icon: "/provider-icons/openai.svg",
  },
  {
    id: "anthropic",
    label: "Claude",
    subscription: "Pro or Max",
    description: "Use your Claude subscription with Claude Code models.",
    icon: ClaudeAI,
  },
  {
    id: "xai",
    label: "Grok",
    subscription: "Shared xAI login",
    description: "Connect an xAI login for Grok. Akeru cannot verify SuperGrok or X Premium+.",
    icon: "/provider-icons/xai.svg",
  },
  {
    id: "kimi-for-coding",
    label: "Kimi For Coding",
    subscription: "Kimi For Coding plan",
    description: "Use Kimi coding models through your Moonshot subscription.",
    icon: "/provider-icons/kimi-for-coding.svg",
  },
];

interface ActiveLogin {
  readonly flow: SubscriptionAuthStartResult;
  readonly providerLabel: string;
  readonly error: string | null;
}

const healthLabels: Readonly<Record<NonNullable<SubscriptionProviderStatus["health"]>, string>> = {
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

function commandError(result: AtomCommandResult<unknown, unknown>): string {
  if (result._tag !== "Failure") return "The request failed.";
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "The request failed.";
}

export function ProviderLoginCard({
  definition,
  status,
  busy,
  onConnect,
  onDisconnect,
  onTest,
}: {
  readonly definition: SubscriptionProviderDefinition;
  readonly status: SubscriptionProviderStatus | undefined;
  readonly busy: boolean;
  readonly onConnect: () => void;
  readonly onDisconnect: () => void;
  readonly onTest: () => void;
}) {
  const connected = status?.connected === true;
  const ProviderIcon = typeof definition.icon === "string" ? null : definition.icon;

  return (
    <SettingsRow
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
            {status?.health ? healthLabels[status.health] : connected ? "Detected" : "Missing"}
          </Badge>
        </span>
      }
      description={definition.description}
      status={definition.subscription}
      control={
        connected ? (
          <div className="flex items-center gap-1.5">
            <Button size="xs" variant="outline" disabled={busy} onClick={onTest}>
              {busy ? (
                <LoaderIcon className="size-3.5 animate-spin" />
              ) : (
                <RefreshCwIcon className="size-3.5" />
              )}
              Check OAuth
            </Button>
            <Button size="xs" variant="ghost-muted" disabled={busy} onClick={onConnect}>
              Reconnect
            </Button>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={`Disconnect ${definition.label}`}
              disabled={busy}
              onClick={onDisconnect}
            >
              <LogOutIcon className="size-3.5" />
            </Button>
          </div>
        ) : (
          <Button size="xs" variant="outline" disabled={busy} onClick={onConnect}>
            {busy ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
            Connect
          </Button>
        )
      }
    />
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
  return (
    <div className="mx-3 mb-3 space-y-3 rounded-xl border bg-muted/30 p-4 sm:mx-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">
          {flow.instructions ?? "Finish signing in on the provider page."}
        </p>
        <Button
          size="xs"
          variant="outline"
          render={<a href={flow.url} target="_blank" rel="noreferrer" />}
        >
          Open sign-in
          <ExternalLinkIcon className="size-3.5" />
        </Button>
      </div>

      {flow.userCode ? (
        <div className="flex items-center gap-2 rounded-lg bg-background px-3 py-2">
          <code className="flex-1 text-sm font-semibold tracking-widest">{flow.userCode}</code>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Copy sign-in code"
            onClick={() => void navigator.clipboard.writeText(flow.userCode ?? "")}
          >
            <CopyIcon className="size-3.5" />
          </Button>
        </div>
      ) : null}

      {flow.completion === "paste" ? (
        <div className="flex gap-2">
          <Input
            value={pastedCode}
            onChange={(event) => onPastedCodeChange(event.currentTarget.value)}
            placeholder="Paste the authorization code"
            aria-label="Authorization code"
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
      ) : (
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <LoaderIcon className="size-3.5 animate-spin" />
          Waiting for approval…
        </div>
      )}

      {login.error ? <p className="text-[13px] text-destructive">{login.error}</p> : null}

      <Button size="xs" variant="ghost-muted" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

export function ProvidersPanel() {
  const environmentId = useSettingsEnvironmentId();
  const statusQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.subscriptionAuth({ environmentId, input: {} }),
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

  const connect = async (definition: SubscriptionProviderDefinition) => {
    if (environmentId === null) return;
    setBusyProvider(definition.id);
    const result = await startAuth({
      environmentId,
      input: { provider: definition.id },
    });
    if (isAtomCommandInterrupted(result)) return;
    if (result._tag === "Failure") {
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
    await cancelAuth({ environmentId, input: { loginId: login.flow.loginId } });
  };

  const disconnect = async (provider: SubscriptionProviderId) => {
    if (environmentId === null) return;
    setBusyProvider(provider);
    const result = await logoutAuth({ environmentId, input: { provider } });
    setBusyProvider(null);
    if (result._tag === "Success") statusQuery.refresh();
  };

  const testHealth = async (provider: SubscriptionProviderId) => {
    if (environmentId === null) return;
    setBusyProvider(provider);
    const result = await testAuth({ environmentId, input: { provider } });
    setBusyProvider(null);
    if (result._tag === "Success") statusQuery.refresh();
  };

  if (activeLogin) {
    return (
      <SettingsPageContainer>
        <SettingsSection title={`Connect ${activeLogin.providerLabel}`}>
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
      <SettingsSection title="Subscriptions">
        <div className="px-3 pb-2 text-[13px] leading-[1.45] text-muted-foreground sm:px-4">
          Connect accounts you already pay for. Akeru uses the coding access included with each
          subscription. Tokens stay on this Akeru server.
        </div>

        {statusQuery.error ? (
          <div className="mx-3 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive sm:mx-4">
            {statusQuery.error}
          </div>
        ) : null}

        {SUBSCRIPTION_PROVIDERS.map((definition) => (
          <ProviderLoginCard
            key={definition.id}
            definition={definition}
            status={statusByProvider.get(definition.id)}
            busy={busyProvider === definition.id || statusQuery.isPending}
            onConnect={() => void connect(definition)}
            onDisconnect={() => void disconnect(definition.id)}
            onTest={() => void testHealth(definition.id)}
          />
        ))}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
