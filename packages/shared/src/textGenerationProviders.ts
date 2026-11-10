/**
 * Live drivers whose instances expose no text generation, so they cannot
 * write chat titles, branch names, or other background text. Settings offer
 * only the other drivers as the fallback model, and the server replaces a
 * saved selection that names one of these.
 */
export const NO_TEXT_GENERATION_DRIVER_KINDS = [
  "claudeCode",
  "kimi",
  "opencodeGo",
  "customOpenai",
] as const;

const noTextGenerationDriverKinds: ReadonlySet<string> = new Set(NO_TEXT_GENERATION_DRIVER_KINDS);

/** True when instances of this driver can generate background text. */
export function driverSupportsTextGeneration(driverKind: string): boolean {
  return !noTextGenerationDriverKinds.has(driverKind);
}
