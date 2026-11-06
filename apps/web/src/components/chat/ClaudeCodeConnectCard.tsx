import { claudeCodeLoginStep, isClaudeCodeProvider } from "@akeru/client-runtime/claude-code-login";
import type { EnvironmentId, ModelSelection, ServerProvider } from "@akeru/contracts";

import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";
import type { ProviderInstanceEntry } from "../../providers/instanceTypes";
import { ClaudeCodeLoginSetup } from "../settings/ClaudeCodeLoginSetup";

/**
 * The Claude Code login a bot runs on, when it still needs setup. Null for
 * other providers and for a login that is ready.
 */
export function claudeCodeSetupFor(
  selection: ModelSelection | null,
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>,
): ServerProvider | null {
  if (!selection) return null;

  const snapshot = instanceEntries.find(
    (entry) => entry.instanceId === selection.instanceId,
  )?.snapshot;

  if (!snapshot || !isClaudeCodeProvider(snapshot) || !snapshot.enabled) return null;

  return claudeCodeLoginStep(snapshot) === "ready" ? null : snapshot;
}

/**
 * Guided Claude Code setup in the chat, so a bot on that login can be fixed
 * without leaving it. It disappears once a check reports the login ready.
 */
export function ClaudeCodeConnectCard({
  environmentId,
  provider,
  botName,
  id,
  className,
}: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly botName: string;
  readonly id?: string | undefined;
  readonly className?: string;
}) {
  const { t } = useI18n();

  return (
    <div
      id={id}
      role="status"
      data-claude-code-connect=""
      className={cn(
        "mx-4 max-w-3xl rounded-xl border bg-card text-card-foreground shadow-sm sm:mx-auto sm:w-full",
        className,
      )}
    >
      <p className="px-3 pt-2.5 text-sm leading-5 sm:px-4">
        {t("Set up your Claude Code login to chat with {bot}", { bot: botName })}
      </p>
      <ClaudeCodeLoginSetup
        environmentId={environmentId}
        instanceId={provider.instanceId}
        provider={provider}
      />
    </div>
  );
}
