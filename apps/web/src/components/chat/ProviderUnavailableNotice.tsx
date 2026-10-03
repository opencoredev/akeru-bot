import type { EnvironmentId } from "@akeru/contracts";
import {
  joinProviderUnavailability,
  type ProviderAvailabilityPresentation,
} from "@akeru/client-runtime/provider-availability";
import { CircleAlertIcon, Settings2Icon } from "lucide-react";

import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";
import { openSettings } from "../../settingsDialogStore";
import type { ProviderCatalogEntry } from "../settings/providerCatalog";
import { SettingsEntityIcon } from "../settings/settingsDetailLayout";
import { subscriptionProviderTargetId } from "../settings/subscriptionProviders";
import { Button } from "../ui/button";

/** Opens the provider's own settings page, or the Providers list when there is none. */
function openProviderSettings(
  provider: ProviderCatalogEntry | null | undefined,
  environmentId: EnvironmentId | null,
) {
  openSettings(
    "providers",
    provider?.account ? subscriptionProviderTargetId(provider.account.id) : null,
    environmentId,
  );
}

/** The provider's logo in a small tile, so a failure card says which account it means. */
export function ProviderLogoTile({ provider }: { readonly provider: ProviderCatalogEntry }) {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background">
      <SettingsEntityIcon icon={provider.icon} />
    </span>
  );
}

/**
 * The next step for a provider failure: a button into that provider's
 * settings, or into this bot's usage settings when an Akeru cap blocked the
 * turn. Renders nothing when waiting or picking another model is the only step.
 */
export function ProviderRepairAction({
  action,
  provider,
  environmentId,
  onOpenUsage,
}: {
  readonly action: ProviderAvailabilityPresentation["action"];
  readonly provider?: ProviderCatalogEntry | null | undefined;
  readonly environmentId: EnvironmentId | null;
  readonly onOpenUsage?: (() => void) | undefined;
}) {
  const { t } = useI18n();

  if (action === "providers") {
    return (
      <Button
        size="sm"
        type="button"
        variant={provider ? "default" : "outline"}
        onClick={() => openProviderSettings(provider, environmentId)}
      >
        {provider ? null : <Settings2Icon aria-hidden="true" />}
        {provider ? t("Connect {provider}", { provider: provider.label }) : t("Open Providers")}
      </Button>
    );
  }

  if (action === "usage" && onOpenUsage) {
    return (
      <Button size="sm" type="button" variant="outline" onClick={onOpenUsage}>
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
  provider,
  environmentId,
  onOpenUsage,
  className,
  id,
}: {
  readonly id?: string | undefined;
  readonly presentation: Pick<ProviderAvailabilityPresentation, "title" | "description" | "action">;
  /** The provider whose settings fix this, when the bot's engine names one. */
  readonly provider?: ProviderCatalogEntry | null | undefined;
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
      {provider ? (
        <ProviderLogoTile provider={provider} />
      ) : (
        <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium leading-5">{presentation.title}</p>
        <p className="mt-0.5 text-xs leading-4.5 text-muted-foreground">
          {presentation.description}
        </p>
        {presentation.action === "providers" || (presentation.action === "usage" && onOpenUsage) ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <ProviderRepairAction
              action={presentation.action}
              provider={provider}
              environmentId={environmentId}
              onOpenUsage={onOpenUsage}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One quiet line under a chat composer while Send is blocked: why, and the
 * single next step. Pass its `id` as the composer's `sendBlockedDescriptionId`
 * so the disabled Send button reads the same reason.
 */
export function ProviderUnavailableLine({
  presentation,
  provider,
  environmentId,
  onOpenUsage,
  id,
}: {
  readonly id?: string | undefined;
  readonly presentation: Pick<ProviderAvailabilityPresentation, "title" | "description" | "action">;
  /** The provider whose settings fix this, when the bot's engine names one. */
  readonly provider?: ProviderCatalogEntry | null | undefined;
  readonly environmentId: EnvironmentId | null;
  readonly onOpenUsage?: (() => void) | undefined;
}) {
  const { t } = useI18n();

  const action =
    presentation.action === "providers" ? (
      <Button
        size="xs"
        type="button"
        variant="outline"
        onClick={() => openProviderSettings(provider, environmentId)}
      >
        {provider ? <SettingsEntityIcon icon={provider.icon} className="size-3.5" /> : null}
        {provider ? t("Connect {provider}", { provider: provider.label }) : t("Set up a provider")}
      </Button>
    ) : presentation.action === "usage" && onOpenUsage ? (
      <Button size="xs" type="button" variant="outline" onClick={onOpenUsage}>
        {t("Bot settings")}
      </Button>
    ) : null;

  return (
    <div
      id={id}
      role="status"
      data-provider-unavailable=""
      className="flex flex-wrap items-center justify-center gap-2 px-4 pb-3 text-center text-xs text-muted-foreground"
    >
      <span>
        {action
          ? t("{title}.", { title: presentation.title })
          : joinProviderUnavailability(presentation, t)}
      </span>
      {action}
    </div>
  );
}
