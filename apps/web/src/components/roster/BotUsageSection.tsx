import { BotId, type AkeruBotUsageSnapshot, type EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { botUsageEnvironment } from "../../state/botUsage";
import { useEnvironmentQuery } from "../../state/query";

type UsageMeasurement = AkeruBotUsageSnapshot["measurements"]["input"];

export function formatUsageMeasurement(measurement: UsageMeasurement): string {
  if (measurement.unavailableEntries === 0) return measurement.tokens.toLocaleString();
  return measurement.tokens === 0 ? "Unavailable" : `${measurement.tokens.toLocaleString()}+`;
}

export function BotUsageSection({
  environmentId,
  botId,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly botId: string;
}) {
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
    <div className="space-y-2" aria-label="Bot usage">
      <div className="text-sm font-medium">Usage</div>
      <div className="rounded-lg border border-border bg-muted/20 px-3 py-2.5 text-sm">
        {usage.error ? (
          <span className="text-muted-foreground">Usage unavailable</span>
        ) : !snapshot ? (
          <span className="text-muted-foreground">{usage.isPending ? "Loading…" : "No usage"}</span>
        ) : (
          <div className="grid grid-cols-2 gap-x-5 gap-y-2">
            <span className="text-muted-foreground">Input</span>
            <span className="text-right">
              {formatUsageMeasurement(snapshot.measurements.input)}
            </span>
            <span className="text-muted-foreground">Output</span>
            <span className="text-right">
              {formatUsageMeasurement(snapshot.measurements.output)}
            </span>
            <span className="text-muted-foreground">Observer</span>
            <span className="text-right">
              {formatUsageMeasurement(snapshot.measurements.observer)}
            </span>
            <span className="text-muted-foreground">Reflector</span>
            <span className="text-right">
              {formatUsageMeasurement(snapshot.measurements.reflector)}
            </span>
            <span className="text-muted-foreground">Cap</span>
            <span className="text-right">
              {snapshot.usageCap
                ? `${snapshot.consumedTokens.toLocaleString()} / ${snapshot.usageCap.limit.toLocaleString()}`
                : "No cap"}
            </span>
            <span className="text-muted-foreground">Estimated cost</span>
            <span className="text-right">
              {snapshot.estimatedCost.status === "available"
                ? `$${snapshot.estimatedCost.usd.toLocaleString()}`
                : "Unavailable"}
            </span>
            <span className="text-muted-foreground">Subscription pool</span>
            <span className="text-right">
              {snapshot.subscriptionPool.status === "available"
                ? `${snapshot.subscriptionPool.used.toLocaleString()} / ${snapshot.subscriptionPool.limit.toLocaleString()} ${snapshot.subscriptionPool.unit}`
                : "Unavailable"}
            </span>
            {snapshot.reservedTokens > 0 ? (
              <>
                <span className="text-muted-foreground">Reserved</span>
                <span className="text-right">{snapshot.reservedTokens.toLocaleString()}</span>
              </>
            ) : null}
            {hasUnavailable ? (
              <span className="col-span-2 text-xs text-muted-foreground">
                Some provider usage is unavailable.
              </span>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
