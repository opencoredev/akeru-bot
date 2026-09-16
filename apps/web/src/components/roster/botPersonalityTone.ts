import {
  BALANCED_BOT_PERSONALITY_TONE,
  MAX_BOT_PERSONALITY_TONE,
  MIN_BOT_PERSONALITY_TONE,
} from "@t3tools/contracts";

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

/**
 * Upper bound of each band, matching the server thresholds. `chill` covers
 * 0-20, `relaxed` 21-44, `balanced` 45-55, `composed` 56-79, and
 * `professional` 80-100.
 */
const BANDS: ReadonlyArray<{ readonly max: number; readonly band: BotPersonalityToneBand }> = [
  {
    max: 20,
    band: {
      id: "chill",
      label: "Chill",
      summary: "Short, relaxed messages. Lowercase reads as natural, like a teammate texting.",
      sample: "on it. migration step timed out again. want me to retry, or find out why first?",
    },
  },
  {
    max: 44,
    band: {
      id: "relaxed",
      label: "Relaxed",
      summary: "Relaxed and direct. Casual wording can sit next to serious thinking.",
      sample:
        "Looking now. The migration step timed out again. Want a retry, or should I find the cause first?",
    },
  },
  {
    max: 55,
    band: {
      id: "balanced",
      label: "Balanced",
      summary: "Natural and direct. Follows your tone and the task more than either endpoint.",
      sample:
        "Checking now. The migration step timed out again. I can retry it or trace the cause.",
    },
  },
  {
    max: 79,
    band: {
      id: "composed",
      label: "Composed",
      summary: "Clear and composed replies, loosening up when you do.",
      sample:
        "I'm checking that now. The migration step timed out again. I can retry the deploy, or trace the cause before we try again.",
    },
  },
  {
    max: MAX_BOT_PERSONALITY_TONE,
    band: {
      id: "professional",
      label: "Professional",
      summary: "Concise and professional, using contractions and ordinary words. Never corporate.",
      sample:
        "I'm looking into it. The migration step timed out again. I'd trace the cause before retrying, since a retry will likely hit the same timeout.",
    },
  },
];

/** The three choices exposed in settings. The server still accepts 0-100 for compatibility. */
export const BOT_PERSONALITY_TONE_OPTIONS = [
  { value: MIN_BOT_PERSONALITY_TONE, label: "Chill" },
  { value: BALANCED_BOT_PERSONALITY_TONE, label: "Balanced" },
  { value: MAX_BOT_PERSONALITY_TONE, label: "Professional" },
] as const;

export type BotPersonalityToneOption = (typeof BOT_PERSONALITY_TONE_OPTIONS)[number];

/** The prompt the sample reply answers, shown above it for context. */
export const BOT_PERSONALITY_TONE_SAMPLE_PROMPT = "the staging deploy failed again";

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

export function botPersonalityToneLabel(tone: number): string {
  return resolveBotPersonalityToneOption(tone).label;
}
