import {
  BALANCED_BOT_PERSONALITY_TONE,
  MAX_BOT_PERSONALITY_TONE,
  MIN_BOT_PERSONALITY_TONE,
} from "@akeru/contracts";
import { createTranslator } from "@akeru/client-runtime/i18n";

import type { useI18n } from "../../i18n";

type Translate = ReturnType<typeof useI18n>["t"];

const translateEnglish: Translate = createTranslator("en").translate;

/**
 * Presentation for the per-bot personality baseline. The bands mirror the
 * thresholds the server uses to build personality instructions, so what the
 * settings page promises is what the bot is actually told.
 *
 * @see apps/server/src/provider/AkeruAgentInstructions.ts
 */

export type BotPersonalityToneBandId =
  | "chill"
  | "relaxed"
  | "balanced"
  | "composed"
  | "professional";

export interface BotPersonalityToneBand {
  readonly id: BotPersonalityToneBandId;
  /** The word shown for this tone band. */
  readonly label: string;
  /** How the bot writes at this setting, in one sentence. */
  readonly summary: string;
  /** An illustrative reply, written locally. No provider call is made. */
  readonly sample: string;
}

/** The visible copy for one band, in the given language. */
function bandCopy(id: BotPersonalityToneBandId, t: Translate): Omit<BotPersonalityToneBand, "id"> {
  switch (id) {
    case "chill":
      return {
        label: t("Chill"),
        summary: t("Short, relaxed messages. Lowercase reads as natural, like a teammate texting."),
        sample: t(
          "on it. migration step timed out again. want me to retry, or find out why first?",
        ),
      };
    case "relaxed":
      return {
        label: t("Relaxed"),
        summary: t("Relaxed and direct. Casual wording can sit next to serious thinking."),
        sample: t(
          "Looking now. The migration step timed out again. Want a retry, or should I find the cause first?",
        ),
      };
    case "balanced":
      return {
        label: t("Balanced"),
        summary: t("Natural and direct. Follows your tone and the task more than either endpoint."),
        sample: t(
          "Checking now. The migration step timed out again. I can retry it or trace the cause.",
        ),
      };
    case "composed":
      return {
        label: t("Composed"),
        summary: t("Clear and composed replies, loosening up when you do."),
        sample: t(
          "I'm checking that now. The migration step timed out again. I can retry the deploy, or trace the cause before we try again.",
        ),
      };
    case "professional":
      return {
        label: t("Professional"),
        summary: t(
          "Concise and professional, using contractions and ordinary words. Never corporate.",
        ),
        sample: t(
          "I'm looking into it. The migration step timed out again. I'd trace the cause before retrying, since a retry will likely hit the same timeout.",
        ),
      };
  }
}

function band(id: BotPersonalityToneBandId): BotPersonalityToneBand {
  return { id, ...bandCopy(id, translateEnglish) };
}

/**
 * Upper bound of each band, matching the server thresholds. `chill` covers
 * 0-20, `relaxed` 21-44, `balanced` 45-55, `composed` 56-79, and
 * `professional` 80-100.
 */
const BANDS: ReadonlyArray<{ readonly max: number; readonly band: BotPersonalityToneBand }> = [
  { max: 20, band: band("chill") },
  { max: 44, band: band("relaxed") },
  { max: 55, band: band("balanced") },
  { max: 79, band: band("composed") },
  { max: MAX_BOT_PERSONALITY_TONE, band: band("professional") },
];

/** A band with its label, summary, and sample in the reader's language. */
export function localizeBotPersonalityToneBand(
  source: BotPersonalityToneBand,
  t: Translate,
): BotPersonalityToneBand {
  return { id: source.id, ...bandCopy(source.id, t) };
}

/** The three choices exposed in settings. The server still accepts 0-100 for compatibility. */
export const BOT_PERSONALITY_TONE_OPTIONS = [
  { value: MIN_BOT_PERSONALITY_TONE, label: "Chill" },
  { value: BALANCED_BOT_PERSONALITY_TONE, label: "Balanced" },
  { value: MAX_BOT_PERSONALITY_TONE, label: "Professional" },
] as const;

export type BotPersonalityToneOption = (typeof BOT_PERSONALITY_TONE_OPTIONS)[number];

/** The prompt the sample reply answers, shown above it for context. */
export function botPersonalityToneSamplePrompt(t: Translate = translateEnglish): string {
  return t("the staging deploy failed again");
}

/** Clamp anything that reached the client to the range the server accepts. */
export function normalizeBotPersonalityTone(tone: number | undefined | null): number {
  if (typeof tone !== "number" || !Number.isFinite(tone)) return BALANCED_BOT_PERSONALITY_TONE;
  const rounded = Math.round(tone);
  if (rounded < MIN_BOT_PERSONALITY_TONE) return MIN_BOT_PERSONALITY_TONE;
  if (rounded > MAX_BOT_PERSONALITY_TONE) return MAX_BOT_PERSONALITY_TONE;
  return rounded;
}

export function resolveBotPersonalityToneBand(tone: number): BotPersonalityToneBand {
  const normalized = normalizeBotPersonalityTone(tone);
  const match = BANDS.find((entry) => normalized <= entry.max);
  return (match ?? BANDS[BANDS.length - 1]!).band;
}

/** Collapse imported or older numeric values into the three settings choices. */
export function resolveBotPersonalityToneOption(tone: number): BotPersonalityToneOption {
  const normalized = normalizeBotPersonalityTone(tone);
  if (normalized < 45) return BOT_PERSONALITY_TONE_OPTIONS[0];
  if (normalized <= 55) return BOT_PERSONALITY_TONE_OPTIONS[1];
  return BOT_PERSONALITY_TONE_OPTIONS[2];
}

export function canonicalizeBotPersonalityTone(tone: number | undefined | null): number {
  return resolveBotPersonalityToneOption(normalizeBotPersonalityTone(tone)).value;
}

/** The visible choice for a tone. Options share their labels with the matching band. */
export function botPersonalityToneLabel(tone: number, t: Translate = translateEnglish): string {
  return bandCopy(resolveBotPersonalityToneBand(resolveBotPersonalityToneOption(tone).value).id, t)
    .label;
}
