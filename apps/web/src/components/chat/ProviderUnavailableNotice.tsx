import type { EnvironmentId } from "@t3tools/contracts";
import type { ProviderAvailabilityPresentation } from "@t3tools/client-runtime/provider-availability";
import { settingsDeepLinkHref } from "@t3tools/client-runtime/settings-deep-link";
import { CircleAlertIcon } from "lucide-react";

import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";
import { parseSettingsDeepLink } from "../../settingsDeepLink";
import { Button } from "../ui/button";
import { SettingsLinkChip } from "./SettingsLinkChip";

const PROVIDERS_HREF = settingsDeepLinkHref("providers");
const PROVIDERS_DESTINATION = parseSettingsDeepLink(PROVIDERS_HREF);

/** The Settings > Providers chip shown wherever reconnecting a provider fixes a failure. */
export function ProviderSettingsChip({
  environmentId,
  className,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly className?: string;
}) {
  const { t } = useI18n();
  if (!PROVIDERS_DESTINATION) return null;
  return (
    <SettingsLinkChip
      href={PROVIDERS_HREF}
      destination={PROVIDERS_DESTINATION}
      environmentId={environmentId}
      {...(className ? { className } : {})}
    >
      {t("Settings > Providers")}
    </SettingsLinkChip>
  );
}

/**
 * The next step for a provider failure: the Providers chip, or a button into
 * this bot's usage settings when an Akeru cap blocked the turn. Renders nothing
 * when waiting or picking another model is the only step.
 */
export function ProviderRepairAction({
  action,
  environmentId,
  onOpenUsage,
}: {
  readonly action: ProviderAvailabilityPresentation["action"];
  readonly environmentId: EnvironmentId | null;
  readonly onOpenUsage?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  if (action === "providers") {
    return <ProviderSettingsChip environmentId={environmentId} />;
  }
  if (action === "usage" && onOpenUsage) {
    return (
      <Button size="xs" type="button" variant="outline" onClick={onOpenUsage}>
        {t("Bot settings")}
      </Button>
    );
  }
  return null;
}

/**
 * Inline message for a bot whose model cannot run right now. Names the
 * provider, what failed, and one next action. Static: no motion, so it can sit
 * above a composer indefinitely.
 */
export function ProviderUnavailableNotice({
  presentation,
  environmentId,
  onOpenUsage,
  className,
  id,
}: {
  readonly id?: string | undefined;
  readonly presentation: Pick<ProviderAvailabilityPresentation, "title" | "description" | "action">;
  readonly environmentId: EnvironmentId | null;
  readonly onOpenUsage?: (() => void) | undefined;
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-start gap-2.5 rounded-xl border border-warning/30 bg-card px-3 py-2.5 text-card-foreground",
        className,
      )}
      id={id}
      role="status"
      data-provider-unavailable=""
    >
      <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium leading-5">{presentation.title}</p>
        <p className="mt-0.5 text-xs leading-4.5 text-muted-foreground">
          {presentation.description}
        </p>
        {presentation.action === "providers" || (presentation.action === "usage" && onOpenUsage) ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <ProviderRepairAction
              action={presentation.action}
              environmentId={environmentId}
              onOpenUsage={onOpenUsage}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
