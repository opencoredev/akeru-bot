import type { SubscriptionProviderId } from "@akeru/contracts";
import {
  providerAccessGuide,
  type ProviderAccessStatusInput,
} from "@akeru/client-runtime/provider-access";

import { useI18n } from "../../i18n";

/**
 * Explains which subscription unlocks a provider, what this environment has,
 * and the next step. Rendered under each provider row in Settings.
 */
export function ProviderAccessDetails({
  provider,
  status,
  models,
  showFailure = true,
}: {
  readonly provider: SubscriptionProviderId;
  readonly status: ProviderAccessStatusInput | undefined;
  readonly models?: ReadonlyArray<string> | undefined;
  /** Off where the row already names the problem, so the raw provider text is not repeated. */
  readonly showFailure?: boolean;
}) {
  const { t } = useI18n();
  const guide = providerAccessGuide(provider, status, { models, t });
  if (!guide) return null;

  const rows: ReadonlyArray<readonly [string, string]> = [
    [
      t("Unlocks with"),
      guide.alternative ? `${guide.unlockedBy} ${guide.alternative}` : guide.unlockedBy,
    ],
    [t("Models"), guide.models],
    [t("API access"), guide.apiAccess],
    [t("Published limits"), guide.limits],
    [t("This environment"), guide.saved],
  ];

  return (
    <div className="pb-2 text-xs text-muted-foreground">
      <p data-access-state={guide.state}>
        <span className="font-medium text-foreground">{guide.stateLabel}.</span> {guide.nextStep}
      </p>
      {showFailure && guide.failure ? (
        <p data-access-failure className="text-destructive">
          {guide.failure}
        </p>
      ) : null}
      {guide.warning ? (
        <p data-access-warning className="text-warning-foreground">
          {guide.warning}
        </p>
      ) : null}
      <details className="mt-1">
        <summary className="w-fit cursor-pointer rounded-sm py-0.5 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          {t("Access details")}
        </summary>
        <dl className="mt-1 grid max-w-2xl grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[8rem_minmax(0,1fr)]">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="font-medium text-foreground/80">{label}</dt>
              <dd className="mb-1 sm:mb-0">{value}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}
