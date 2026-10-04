import type { UpdateBotInput } from "@akeru/client-runtime/state/bots";
import type { BotId } from "@akeru/contracts";

type ProviderUsageCap = {
  readonly available: boolean;
  readonly limit: number | null | undefined;
};

export function parseBotUsageCapInput(input: string): number | null | undefined {
  if (input.trim().length === 0) return null;
  const limit = Number(input);

  return Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
}

export function resolveBotUsageCapForProvider(
  input: string,
  providerDriver?: string,
): ProviderUsageCap {
  if (providerDriver === "grok") {
    return { available: false, limit: null };
  }

  return { available: true, limit: parseBotUsageCapInput(input) };
}

export function buildBotUsageCapPatch(
  botId: BotId,
  input: string,
  providerDriver?: string,
): UpdateBotInput | null {
  const { limit } = resolveBotUsageCapForProvider(input, providerDriver);

  if (limit === undefined) return null;

  return { botId, usageCap: limit === null ? null : { unit: "tokens", limit } };
}
