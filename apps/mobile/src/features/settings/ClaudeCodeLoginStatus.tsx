import { useAtomValue } from "@effect/atom-react";
import {
  CLAUDE_CODE_INSTALL_URL,
  claudeCodeLoginCommandForInstance,
  claudeCodeLoginStep,
  claudeCodeLoginStepCopy,
  isClaudeCodeProvider,
  type ClaudeCodeLoginInstruction,
} from "@akeru/client-runtime/claude-code-login";
import type { EnvironmentId, ServerProvider } from "@akeru/contracts";
import { useState } from "react";
import { Linking, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useMobileI18n } from "../../lib/i18n";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { copySignInCode } from "./copySignInCode";

function Action(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled === true }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={`min-h-11 justify-center rounded-xl bg-subtle px-3 py-2 ${props.disabled ? "opacity-50" : ""}`}
    >
      <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
    </Pressable>
  );
}

/** One Claude Code login: its step, the fix, and the login command for that account. */
export function ClaudeCodeLoginRow({
  environmentId,
  provider,
  login,
}: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly login: ClaudeCodeLoginInstruction;
}) {
  const { t } = useMobileI18n();
  const [verifying, setVerifying] = useState(false);
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);

  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });

  const step = claudeCodeLoginStep(provider);
  const copy = claudeCodeLoginStepCopy(step);
  const command = login.command;
  const account = [provider.auth.label, provider.auth.email].filter(Boolean).join(" · ");

  const verify = async () => {
    setVerifying(true);
    await refreshProviders({ environmentId, input: { instanceId: provider.instanceId } });
    setVerifying(false);
  };

  return (
    <View className="gap-2 border-b border-border-subtle py-3">
      <Text className="text-base font-t3-medium text-foreground">
        {provider.displayName ?? t("Claude Agent")}
      </Text>
      <Text className="text-sm font-t3-medium text-foreground">{t(copy.title)}</Text>
      <Text className="text-sm text-foreground-muted">
        {step === "ready" && account ? t("Logged in as {account}.", { account }) : t(copy.detail)}
      </Text>
      {step === "error" && provider.message ? (
        <Text accessibilityRole="alert" className="text-sm text-danger">
          {provider.message}
        </Text>
      ) : null}
      {(step === "not-installed" || step === "logged-out" || step === "error") &&
      login.kind === "hidden-folder" ? (
        <Text className="text-sm text-foreground-muted">
          {t(
            "This account's Claude Code folder is saved as a hidden value. In a terminal on this environment's machine, set CLAUDE_CONFIG_DIR to that folder, then run:",
          )}
        </Text>
      ) : null}
      {(step === "not-installed" || step === "logged-out" || step === "error") &&
      login.kind === "hidden-home" ? (
        <Text className="text-sm text-foreground-muted">
          {t(
            "This account's home folder is saved as a hidden value. In a terminal on this environment's machine, set {variable} to that folder, then run:",
            { variable: login.variable },
          )}
        </Text>
      ) : null}
      {step === "not-installed" || step === "logged-out" || step === "error" ? (
        <Text
          selectable
          className="rounded-xl bg-subtle px-3 py-2 font-mono text-sm text-foreground"
        >
          {command}
        </Text>
      ) : null}
      {copied === "failed" ? (
        <Text className="text-sm text-foreground-muted">
          {t("Couldn't copy the command. Select it and copy it manually.")}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        {step === "not-installed" || step === "error" ? (
          <Action
            label={t("Open the Claude Code install guide")}
            onPress={() => void Linking.openURL(CLAUDE_CODE_INSTALL_URL).catch(() => undefined)}
          />
        ) : null}
        {step === "not-installed" || step === "logged-out" || step === "error" ? (
          <Action
            label={copied === "copied" ? t("Copied") : t("Copy command")}
            onPress={() =>
              void copySignInCode(command).then((ok) => setCopied(ok ? "copied" : "failed"))
            }
          />
        ) : null}
        <Action label={t("Verify")} disabled={verifying} onPress={() => void verify()} />
      </View>
    </View>
  );
}

/**
 * Claude Code login connections on this environment, with each one's setup
 * step and the fix. Turning the login on or off happens in desktop or web
 * Settings, where the machine that runs Claude Code is set up.
 */
export function ClaudeCodeLoginStatus({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const { t } = useMobileI18n();
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const providers = config?.providers ?? [];
  const logins = providers.filter((provider) => isClaudeCodeProvider(provider) && provider.enabled);

  if (logins.length === 0) return null;

  return (
    <SettingsSection title={t("Claude Agent")} card>
      <View className="px-4">
        {logins.map((provider) => (
          <ClaudeCodeLoginRow
            key={provider.instanceId}
            environmentId={environmentId}
            provider={provider}
            login={claudeCodeLoginCommandForInstance({
              instance: config?.settings.providerInstances[provider.instanceId],
              provider,
              os: config?.environment.platform.os,
            })}
          />
        ))}
      </View>
    </SettingsSection>
  );
}
