import { BotId, type AkeruBotUsageSnapshot, type EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { botUsageEnvironment } from "../../state/botUsage";
import { useEnvironmentQuery } from "../../state/query";

type UsageMeasurement = AkeruBotUsageSnapshot["measurements"]["input"];

export function formatBotUsage(measurement: UsageMeasurement): string {
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
  const memoryTokens = snapshot
    ? snapshot.measurements.observer.tokens + snapshot.measurements.reflector.tokens
    : 0;
  const memoryUnavailable = snapshot
    ? snapshot.measurements.observer.unavailableEntries +
      snapshot.measurements.reflector.unavailableEntries
    : 0;

  return (
    <div className="space-y-2" aria-label="Bot usage">
      <div className="text-sm font-medium">Usage</div>
      <div className="rounded-lg border border-border bg-muted/20 px-3 py-2.5 text-sm">
        {usage.error ? (
          <span className="text-muted-foreground">Usage unavailable</span>
        ) : !snapshot ? (
          <span className="text-muted-foreground">{usage.isPending ? "Loading…" : "No usage"}</span>
        ) : (
          <div className="grid grid-cols-2 gap-x-5 gap-y-1.5">
            <span className="text-muted-foreground">Input</span>
            <span className="text-right">{formatBotUsage(snapshot.measurements.input)}</span>
            <span className="text-muted-foreground">Output</span>
            <span className="text-right">{formatBotUsage(snapshot.measurements.output)}</span>
            <span className="text-muted-foreground">Memory</span>
            <span className="text-right">
              {formatBotUsage({ tokens: memoryTokens, unavailableEntries: memoryUnavailable })}
            </span>
            <span className="text-muted-foreground">Cap</span>
            <span className="text-right">
              {snapshot.usageCap
                ? `${snapshot.consumedTokens.toLocaleString()} / ${snapshot.usageCap.limit.toLocaleString()}`
                : "No cap"}
            </span>
            {snapshot.usageCap && snapshot.consumedTokens >= snapshot.usageCap.limit ? (
              <span className="col-span-2 text-xs text-destructive">Cap reached</span>
            ) : snapshot.reservedTokens > 0 ? (
              <span className="col-span-2 text-xs text-muted-foreground">
                {snapshot.reservedTokens.toLocaleString()} reserved
              </span>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
