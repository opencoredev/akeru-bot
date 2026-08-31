import { formatTokens, formatUsd } from "@t3tools/shared/usageFormat";

import { formatBotStepEngine, type BotStepMeterData } from "./botStepMeter.logic";

export function BotStepMeter({ meter }: { readonly meter: BotStepMeterData | undefined }) {
  if (!meter) return null;

  return (
    <div
      className="mt-0.5 truncate font-mono text-[0.7rem] tabular-nums text-muted-foreground/70"
      data-testid="bot-step-meter"
    >
      {formatBotStepEngine(meter.engine)} ·{" "}
      {meter.tokens === null ? "—" : formatTokens(meter.tokens)}
      {" tokens · "}
      {meter.costUsd === null ? "$—" : formatUsd(meter.costUsd)}
      {meter.hardStopReached ? " · Hard stop" : null}
    </div>
  );
}
