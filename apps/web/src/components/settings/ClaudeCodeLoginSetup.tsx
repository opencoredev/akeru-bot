import { Predicate } from "effect";
import { safeErrorLogAttributes } from "@akeru/client-runtime/errors";
import {
  CLAUDE_CODE_INSTALL_URL,
  claudeCodeLoginCommandForInstance,
  claudeCodeLoginStep,
  claudeCodeLoginStepCopy,
  type ClaudeCodeLoginStep,
} from "@akeru/client-runtime/claude-code-login";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@akeru/client-runtime/state/runtime";
import type { EnvironmentId, ProviderInstanceId, ServerProvider } from "@akeru/contracts";
import { CheckIcon, CopyIcon, ExternalLinkIcon, LoaderIcon, RefreshCwIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SettingsStatus } from "./settingsDetailLayout";
import type { ConnectionTone } from "./providerStatus";

const STEP_TONE: Readonly<Record<ClaudeCodeLoginStep, ConnectionTone>> = {
  checking: "pending",
  "not-installed": "attention",
  "logged-out": "attention",
  ready: "positive",
  error: "attention",
};

const STEP_LABEL: Readonly<Record<ClaudeCodeLoginStep, string>> = {
  checking: "Checking",
  "not-installed": "Not installed",
  "logged-out": "Logged out",
  ready: "Ready",
  error: "Needs attention",
};

/** A shell command with a copy action. The text stays selectable if copying fails. */
function CommandCopy({ command }: { readonly command: string }) {
  const { t } = useI18n();

  const [copyResult, setCopyResult] = useState<{
    readonly command: string;
    readonly state: "copied" | "failed";
  } | null>(null);

  const copyState = copyResult?.command === command ? copyResult.state : "idle";

  const copy = async () => {
    const copied = await writeTextToClipboard(command, "command").catch(() => false);
    setCopyResult({ command, state: copied ? "copied" : "failed" });
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 rounded-lg bg-background px-3 py-2 ring-1 ring-border/70">
        <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-nowrap select-all">
          {command}
        </code>
        <Button size="xs" variant="ghost" onClick={() => void copy()}>
          {copyState === "copied" ? (
            <CheckIcon className="size-3.5" />
          ) : (
            <CopyIcon className="size-3.5" />
          )}
          {copyState === "copied" ? t("Copied") : t("Copy command")}
        </Button>
      </div>
      {copyState === "failed" ? (
        <p role="alert" className="text-xs text-muted-foreground">
          {t("Couldn't copy the command. Select it and copy it manually.")}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Guided setup for one Claude Code login connection: install Claude Code, log
 * in with `claude auth login`, verify, then ready. Every step reads the
 * instance's live provider snapshot, so a check run anywhere updates it here.
 */
export function ClaudeCodeLoginSetup({
  environmentId,
  instanceId,
  provider,
  className,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
  readonly className?: string;
}) {
  const { t, translate } = useI18n();
  const [verifying, setVerifying] = useState(false);

  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });

  const step = claudeCodeLoginStep(provider);
  const copy = claudeCodeLoginStepCopy(step);
  const settings = useEnvironmentSettings(environmentId);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));

  // The command runs on the environment's machine: its shell, the account's folder.
  const login = claudeCodeLoginCommandForInstance({
    instance: settings.providerInstances?.[instanceId],
    provider,
    os: serverConfig?.environment.platform.os,
  });

  const verify = async () => {
    if (verifying) return;
    setVerifying(true);
    const result = await refreshProviders({ environmentId, input: { instanceId } });
    setVerifying(false);

    if (Predicate.isTagged(result, "Failure") && !isAtomCommandInterrupted(result)) {
      console.warn("Failed to verify Claude Code login", {
        operation: "verify-claude-code-login",
        environmentId,
        ...safeErrorLogAttributes(squashAtomCommandFailure(result)),
      });
    }
  };

  const account = [provider?.auth.label, provider?.auth.email].filter(Boolean).join(" · ");

  return (
    <div
      data-settings-row=""
      data-claude-code-login={step}
      className={cn("space-y-3 rounded-xl px-3 py-3 sm:px-4", className)}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-sm font-medium text-foreground">{translate(copy.title)}</p>
          <p className="text-13px leading-copy text-muted-foreground">
            {step === "ready" && account
              ? t("Logged in as {account}.", { account })
              : translate(copy.detail)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <SettingsStatus tone={STEP_TONE[step]} label={translate(STEP_LABEL[step])} />
          <Button size="xs" variant="outline" disabled={verifying} onClick={() => void verify()}>
            {verifying ? (
              <LoaderIcon className="size-3.5 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-3.5" />
            )}
            {t("Verify")}
          </Button>
        </div>
      </div>

      {step === "error" && provider?.message ? (
        <p role="alert" className="text-13px leading-copy text-destructive">
          {provider.message}
        </p>
      ) : null}

      {step === "not-installed" || step === "error" ? (
        <a
          href={CLAUDE_CODE_INSTALL_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-13px font-medium text-foreground underline-offset-4 hover:underline"
        >
          {t("Open the Claude Code install guide")}
          <ExternalLinkIcon aria-hidden className="size-3.5" />
        </a>
      ) : null}

      {step === "not-installed" || step === "logged-out" || step === "error" ? (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">
            {login.kind === "hidden-folder"
              ? t(
                  "This account's Claude Code folder is saved as a hidden value. In a terminal on this environment's machine, set CLAUDE_CONFIG_DIR to that folder, then run:",
                )
              : login.kind === "hidden-home"
                ? t(
                    "This account's home folder is saved as a hidden value. In a terminal on this environment's machine, set {variable} to that folder, then run:",
                    { variable: login.variable },
                  )
                : step === "not-installed"
                  ? t("Then log in on the same machine:")
                  : t("Log in on this environment's machine:")}
          </p>
          <CommandCopy command={login.command} />
        </div>
      ) : null}
    </div>
  );
}
