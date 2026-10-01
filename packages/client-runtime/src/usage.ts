import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageSummary,
  type UsageSummaryInput,
} from "@akeru/contracts";
import { mergeUsage, type EnvironmentUsage } from "@akeru/shared/usageMerge";

export function usageWindowKey(input: UsageSummaryInput): string {
  return JSON.stringify({
    sinceDay: input.sinceDay,
    untilDay: input.untilDay,
    timeZone: input.timeZone,
    resolution: input.resolution,
    sinceTime: input.sinceTime,
    untilTime: input.untilTime,
  });
}

export interface EnvironmentUsageStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly summary: UsageSummary | null;
}

export function aggregateUsage(environments: readonly EnvironmentUsageStatus[]) {
  const answered: EnvironmentUsage[] = environments.flatMap((environment) =>
    environment.summary === null
      ? []
      : [
          {
            environmentId: environment.environmentId,
            label: environment.label,
            summary: environment.summary,
          },
        ],
  );

  const stillReporting = environments.some(
    (environment) => environment.summary === null && environment.error === null,
  );

  return {
    merged: mergeUsage(answered, USAGE_CONTRACT_VERSION),
    isPending: answered.length === 0 && stillReporting,
    isPartial: answered.length > 0 && stillReporting,
  };
}
