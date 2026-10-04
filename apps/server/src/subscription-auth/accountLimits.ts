import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";

// How long an account that hit a limit sits out when the provider did not say
// when it resets. Requests use the next linked account meanwhile.
const LIMIT_COOLDOWN_MS = 60 * 60_000;

const LIMIT_PATTERN =
  /usage limit|rate limit|too many requests|quota|usage cap|limit reached|hit your .*limit|spending limit|budget exceeded|max usage|\b429\b/i;

export function isAccountLimitMessage(message: string): boolean {
  return LIMIT_PATTERN.test(message);
}

/** When an account that hit a limit may be tried again, from the provider's wording when it gives one. */
export function limitRetryAt(message: string, at: string): string {
  const start = Date.parse(at);
  const base = Number.isFinite(start) ? start : Effect.runSync(Clock.currentTimeMillis);
  const window = /(?:try again|resets?|retry)\s+(?:in|after)\s+([^.;]*)/i.exec(message)?.[1];
  let ms = 0;

  if (window) {
    const units = new Map([
      ["s", 1_000],
      ["m", 60_000],
      ["h", 3_600_000],
      ["d", 86_400_000],
    ]);

    for (const match of window.matchAll(
      /(\d+(?:\.\d+)?)\s*(s|sec|second|m|min|minute|h|hr|hour|d|day)s?\b/gi,
    )) {
      ms += Number(match[1]) * (units.get(match[2]!.toLowerCase()[0]!) ?? 0);
    }
  }

  return DateTime.formatIso(DateTime.makeUnsafe(base + (ms > 0 ? ms : LIMIT_COOLDOWN_MS)));
}
