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
): string {
  if (measurement.unavailableEntries === 0) return measurement.tokens.toLocaleString();
  return measurement.tokens === 0 ? t("Unavailable") : `${measurement.tokens.toLocaleString()}+`;
}

export function BotUsageSection({
  environmentId,
  botId,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly botId: string;
}) {
  const { t } = useI18n();
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
    <div className="space-y-2" aria-label={t("Bot usage")}>
      <div className="text-sm font-medium">{t("Usage")}</div>
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
              {formatUsageMeasurement(snapshot.measurements.input, t)}
            </span>
            <span className="text-muted-foreground">{t("Output")}</span>
            <span className="text-right">
              {formatUsageMeasurement(snapshot.measurements.output, t)}
            </span>
            <span className="text-muted-foreground">{t("Observer")}</span>
            <span className="text-right">
              {formatUsageMeasurement(snapshot.measurements.observer, t)}
            </span>
            <span className="text-muted-foreground">{t("Reflector")}</span>
            <span className="text-right">
              {formatUsageMeasurement(snapshot.measurements.reflector, t)}
            </span>
            <span className="text-muted-foreground">{t("Cap")}</span>
            <span className="text-right">
              {snapshot.usageCap
                ? t("{consumed} / {limit} tokens", {
                    consumed: snapshot.consumedTokens.toLocaleString(),
                    limit: snapshot.usageCap.limit.toLocaleString(),
                  })
                : t("No cap")}
            </span>
            <span className="text-muted-foreground">{t("Estimated cost")}</span>
            <span className="text-right">
              {snapshot.estimatedCost.status === "available"
                ? `$${snapshot.estimatedCost.usd.toLocaleString(undefined, {
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
                      percent: snapshot.subscriptionPool.used.toLocaleString(),
                    })
                  : snapshot.subscriptionPool.unit === "tokens"
                    ? t("{consumed} / {limit} tokens", {
                        consumed: snapshot.subscriptionPool.used.toLocaleString(),
                        limit: snapshot.subscriptionPool.limit.toLocaleString(),
                      })
                    : `${snapshot.subscriptionPool.used.toLocaleString()} / ${snapshot.subscriptionPool.limit.toLocaleString()} ${snapshot.subscriptionPool.unit}`
                : t("Unavailable")}
            </span>
            {snapshot.reservedTokens > 0 ? (
              <>
                <span className="text-muted-foreground">{t("Reserved")}</span>
                <span className="text-right">{snapshot.reservedTokens.toLocaleString()}</span>
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
