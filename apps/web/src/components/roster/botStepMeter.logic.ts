import {
  AkeruStepUsageSnapshot,
  type BotEngine,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isAkeruStepUsageSnapshot = Schema.is(AkeruStepUsageSnapshot);

export interface BotStepMeterData {
  readonly engine: BotEngine;
  readonly tokens: number | null;
  readonly costUsd: number | null;
  readonly hardStopReached: boolean;
}

export function buildBotStepMeters(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyMap<string, BotStepMeterData> {
  const meters = new Map<string, BotStepMeterData>();
  const cappedTurns = new Set<string>();
  for (const activity of activities) {
    if (activity.kind === "bot.usage-cap.hit" && activity.turnId !== null) {
      cappedTurns.add(activity.turnId);
      continue;
    }
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
      hardStopReached: false,
    });
  }
  for (const turnId of cappedTurns) {
    const meter = meters.get(turnId);
    if (meter) meters.set(turnId, { ...meter, hardStopReached: true });
  }
  return meters;
}

export function formatBotStepEngine(engine: BotEngine): string {
  return engine.model.startsWith(`${engine.provider}/`)
    ? engine.model
    : `${engine.provider}/${engine.model}`;
}
