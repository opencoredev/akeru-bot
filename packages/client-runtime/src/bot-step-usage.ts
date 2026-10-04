import {
  AkeruStepUsageSnapshot,
  type BotEngine,
  type OrchestrationThreadActivity,
} from "@akeru/contracts";
import * as Schema from "effect/Schema";

const isAkeruStepUsageSnapshot = Schema.is(AkeruStepUsageSnapshot);

export interface BotStepMeterData {
  readonly engine: BotEngine;
  readonly tokens: number | null;
  readonly costUsd: number | null;
}

export function buildBotStepMeters(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyMap<string, BotStepMeterData> {
  const meters = new Map<string, BotStepMeterData>();

  for (const activity of activities) {
    if (
      activity.kind !== "bot.step-usage.updated" ||
      activity.turnId === null ||
      !isAkeruStepUsageSnapshot(activity.payload)
    ) {
      continue;
    }

    meters.set(activity.turnId, {
      engine: activity.payload.engine,
      tokens: activity.payload.tokens,
      costUsd:
        activity.payload.estimatedCost.status === "available"
          ? activity.payload.estimatedCost.usd
          : null,
    });
  }

  return meters;
}

export function formatBotStepEngine(engine: BotEngine): string {
  return engine.model.startsWith(`${engine.provider}/`)
    ? engine.model
    : `${engine.provider}/${engine.model}`;
}
