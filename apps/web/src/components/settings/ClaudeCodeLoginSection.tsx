import { useAtomValue } from "@effect/atom-react";
import { CLAUDE_CODE_DRIVER } from "@akeru/client-runtime/claude-code-login";
import {
  defaultInstanceIdForDriver,
  type EnvironmentId,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  resolveProviderInstanceEnabled,
} from "@akeru/contracts";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useI18n } from "../../i18n";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { ClaudeCodeLoginSetup } from "./ClaudeCodeLoginSetup";
import { SettingsMessageRow } from "./settingsDetailLayout";
import { SettingsSection } from "./settingsLayout";

const CLAUDE_CODE_DRIVER_KIND = ProviderDriverKind.make(CLAUDE_CODE_DRIVER);

const CLAUDE_CODE_INSTANCE_ID = defaultInstanceIdForDriver(CLAUDE_CODE_DRIVER_KIND);

/** The instance the Claude page turns on: one Claude Code login per environment by default. */
const CLAUDE_CODE_LOGIN_INSTANCE: ProviderInstanceConfig = {
  driver: CLAUDE_CODE_DRIVER_KIND,
  enabled: true,
  displayName: "Claude Agent",
};

/**
 * The Claude Code login instance with the connection turned on, keeping an
 * existing account's settings. Undefined when it is already on.
 */
export function enabledClaudeCodeLoginInstance(
  existing: ProviderInstanceConfig | undefined,
): ProviderInstanceConfig | undefined {
  if (existing === undefined) return CLAUDE_CODE_LOGIN_INSTANCE;

  return resolveProviderInstanceEnabled(existing) ? undefined : { ...existing, enabled: true };
}

/**
 * "Use your Claude Code login" on the Claude page. Turning it on adds a
 * Claude Code login connection beside the API key; turning it off removes
 * that connection and leaves the API key alone.
 */
export function ClaudeCodeLoginSection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const { t } = useI18n();
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);

  const serverProviders =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;

  const instance = settings.providerInstances?.[CLAUDE_CODE_INSTANCE_ID];
  const live = serverProviders.find((provider) => provider.instanceId === CLAUDE_CODE_INSTANCE_ID);

  const useLogin = () =>
    updateSettings({
      providerInstances: {
        ...settings.providerInstances,
        [CLAUDE_CODE_INSTANCE_ID]: CLAUDE_CODE_LOGIN_INSTANCE,
      },
    });

  const stopUsingLogin = () => {
    const next = { ...settings.providerInstances };
    delete next[CLAUDE_CODE_INSTANCE_ID];
    updateSettings({ providerInstances: next });
  };

  return (
    <SettingsSection
      id="provider-claude-code-login"
      title={t("Claude Agent")}
      headerAction={
        instance ? (
          <Button size="xs" variant="ghost-muted" onClick={stopUsingLogin}>
            {t("Stop using Claude Agent")}
          </Button>
        ) : null
      }
    >
      {instance ? (
        <ClaudeCodeLoginSetup
          environmentId={environmentId}
          instanceId={CLAUDE_CODE_INSTANCE_ID}
          provider={live}
        />
      ) : (
        <SettingsMessageRow
          action={
            <Button size="xs" variant="outline" onClick={useLogin}>
              {t("Use your Claude Code login")}
            </Button>
          }
        >
          {t(
            "Run Claude bots on the Claude Code installed on this environment's machine, with the login you made there. No API key needed.",
          )}
        </SettingsMessageRow>
      )}
    </SettingsSection>
  );
}
