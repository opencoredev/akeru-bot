import { useAtomValue } from "@effect/atom-react";
import { CLAUDE_CODE_DRIVER, claudeCodeLoginStep } from "@akeru/client-runtime/claude-code-login";
import {
  defaultInstanceIdForDriver,
  type EnvironmentId,
  ProviderDriverKind,
} from "@akeru/contracts";
import { ArrowRightIcon } from "lucide-react";
import { useEffect } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useI18n } from "../../i18n";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { ClaudeCodeLoginSetup } from "../settings/ClaudeCodeLoginSetup";
import { enabledClaudeCodeLoginInstance } from "../settings/ClaudeCodeLoginSection";
import { ONBOARDING_HEADING_CLASS } from "./onboardingStyles";

const CLAUDE_CODE_INSTANCE_ID = defaultInstanceIdForDriver(
  ProviderDriverKind.make(CLAUDE_CODE_DRIVER),
);

/** True once the environment's Claude Code login reports ready. */
export function useClaudeCodeLoginReady(environmentId: EnvironmentId): boolean {
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;

  const live = providers.find((provider) => provider.instanceId === CLAUDE_CODE_INSTANCE_ID);

  return live !== undefined && live.enabled && claudeCodeLoginStep(live) === "ready";
}

/**
 * Onboarding's Claude Code login path: it turns the connection on, walks the
 * user through install and `claude auth login`, and continues once ready.
 */
export function OnboardingClaudeCodeStep({
  environmentId,
  onBack,
  onContinue,
}: {
  readonly environmentId: EnvironmentId;
  readonly onBack: () => void;
  readonly onContinue: () => void;
}) {
  const { t } = useI18n();
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const ready = useClaudeCodeLoginReady(environmentId);

  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;

  const live = providers.find((provider) => provider.instanceId === CLAUDE_CODE_INSTANCE_ID);
  // Adds the connection, or turns a switched-off one back on with its account settings.
  useEffect(() => {
    const enabledInstance = enabledClaudeCodeLoginInstance(
      settings.providerInstances?.[CLAUDE_CODE_INSTANCE_ID],
    );

    if (!enabledInstance) return;
    updateSettings({
      providerInstances: {
        ...settings.providerInstances,
        [CLAUDE_CODE_INSTANCE_ID]: enabledInstance,
      },
    });
  }, [settings.providerInstances, updateSettings]);

  return (
    <div className="space-y-4">
      <h1 className={ONBOARDING_HEADING_CLASS}>{t("Use your Claude Code login")}</h1>
      <p className="text-sm leading-6 text-muted-foreground">
        {t(
          "Akeru runs Claude Code on this machine with the login you made there. It never sees your Claude password or token.",
        )}
      </p>
      <div className="rounded-xl border border-border/70 bg-background/60">
        <ClaudeCodeLoginSetup
          environmentId={environmentId}
          instanceId={CLAUDE_CODE_INSTANCE_ID}
          provider={live}
        />
      </div>
      <div className="flex gap-2">
        <Button variant="ghost-muted" onClick={onBack}>
          {t("Back")}
        </Button>
        <Button size="onboarding" className="flex-1" disabled={!ready} onClick={onContinue}>
          {t("Continue")}
          <ArrowRightIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}
