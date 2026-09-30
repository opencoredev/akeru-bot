import { BotId, type AkeruBotUsageSnapshot, type EnvironmentId } from "@t3tools/contracts";
import { createTranslator } from "@t3tools/client-runtime/i18n";
import { useMemo } from "react";

import { useI18n } from "../../i18n";
import { botUsageEnvironment } from "../../state/botUsage";
import { useEnvironmentQuery } from "../../state/query";

type UsageMeasurement = AkeruBotUsageSnapshot["measurements"]["input"];

type Translate = ReturnType<typeof useI18n>["t"];

const translateEnglish: Translate = createTranslator("en").translate;

export function formatUsageMeasurement(
  measurement: UsageMeasurement,
  t: Translate = translateEnglish,
  formatNumber: (value: number) => string = (value) => value.toLocaleString(),
): string {
  if (measurement.unavailableEntries === 0) return formatNumber(measurement.tokens);
  return measurement.tokens === 0 ? t("Unavailable") : `${formatNumber(measurement.tokens)}+`;
}

export function BotUsageSection({
  environmentId,
  botId,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly botId: string;
}) {
  const { t, formatNumber } = useI18n();
  const usageAtom = useMemo(
    () =>
      environmentId
        ? botUsageEnvironment.summary({
            environmentId,
            input: { botId: BotId.make(botId) },
          })
        : null,
    [botId, environmentId],
  );
  const usage = useEnvironmentQuery(usageAtom);
  const snapshot = usage.data;
  const hasUnavailable = snapshot
    ? Object.values(snapshot.measurements).some((value) => value.unavailableEntries > 0)
    : false;

  return (
    <div aria-label={t("Bot usage")}>
      <div className="rounded-lg border border-border bg-muted/20 px-3 py-2.5 text-sm">
        {usage.error ? (
          <span className="text-muted-foreground">{t("Usage unavailable")}</span>
        ) : !snapshot ? (
          <span className="text-muted-foreground">
            {usage.isPending ? t("Loading…") : t("No usage")}
          </span>
        ) : (
          <div className="grid grid-cols-2 gap-x-5 gap-y-2">
            <span className="text-muted-foreground">{t("Input")}</span>
            <span className="text-right">
              {formatUsageMeasurement(snapshot.measurements.input, t, formatNumber)}
            </span>
            <span className="text-muted-foreground">{t("Output")}</span>
            <span className="text-right">
              {formatUsageMeasurement(snapshot.measurements.output, t, formatNumber)}
            </span>
            <span className="text-muted-foreground">{t("Observer")}</span>
            <span className="text-right">
              {formatUsageMeasurement(snapshot.measurements.observer, t, formatNumber)}
            </span>
            <span className="text-muted-foreground">{t("Reflector")}</span>
            <span className="text-right">
              {formatUsageMeasurement(snapshot.measurements.reflector, t, formatNumber)}
            </span>
            <span className="text-muted-foreground">{t("Cap")}</span>
            <span className="text-right">
              {snapshot.usageCap
                ? t("{consumed} / {limit} tokens", {
                    consumed: formatNumber(snapshot.consumedTokens),
                    limit: formatNumber(snapshot.usageCap.limit),
                  })
                : t("No cap")}
            </span>
            <span className="text-muted-foreground">{t("Estimated cost")}</span>
            <span className="text-right">
              {snapshot.estimatedCost.status === "available"
                ? `$${formatNumber(snapshot.estimatedCost.usd, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}`
                : t("Unavailable")}
            </span>
            <span className="col-span-2 text-xs text-muted-foreground">
              {t("Estimated from reported model usage; this is not subscription spend.")}
            </span>
            <span className="text-muted-foreground">{t("Subscription pool")}</span>
            <span className="text-right">
              {snapshot.subscriptionPool.status === "available"
                ? snapshot.subscriptionPool.unit === "percent"
                  ? t("{percent}% of pool", {
                      percent: formatNumber(snapshot.subscriptionPool.used),
                    })
                  : snapshot.subscriptionPool.unit === "tokens"
                    ? t("{consumed} / {limit} tokens", {
                        consumed: formatNumber(snapshot.subscriptionPool.used),
                        limit: formatNumber(snapshot.subscriptionPool.limit),
                      })
                    : `${formatNumber(snapshot.subscriptionPool.used)} / ${formatNumber(snapshot.subscriptionPool.limit)} ${snapshot.subscriptionPool.unit}`
                : t("Unavailable")}
            </span>
            {snapshot.reservedTokens > 0 ? (
              <>
                <span className="text-muted-foreground">{t("Reserved")}</span>
                <span className="text-right">{formatNumber(snapshot.reservedTokens)}</span>
              </>
            ) : null}
            {hasUnavailable ? (
              <span className="col-span-2 text-xs text-muted-foreground">
                {t("Some provider usage is unavailable.")}
              </span>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
