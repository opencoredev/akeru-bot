import { formatTokens, formatUsd } from "@akeru/shared/usageFormat";

import { useI18n } from "../../i18n";
import { formatBotStepEngine, type BotStepMeterData } from "./botStepMeter.logic";

export function BotStepMeter({ meter }: { readonly meter: BotStepMeterData | undefined }) {
  const { t } = useI18n();
  if (!meter) return null;

  // Unknown usage is left out rather than shown as a placeholder.
  const parts = [
    formatBotStepEngine(meter.engine),
    meter.tokens === null ? null : t("{tokens} tokens", { tokens: formatTokens(meter.tokens) }),
    meter.costUsd === null ? null : formatUsd(meter.costUsd),
    meter.hardStopReached ? t("Hard stop") : null,
  ].filter((part) => part !== null);

  return (
    <div
      className="mt-0.5 truncate text-xs tabular-nums text-muted-foreground/70"
      data-testid="bot-step-meter"
    >
      {parts.join(" · ")}
    </div>
  );
}
