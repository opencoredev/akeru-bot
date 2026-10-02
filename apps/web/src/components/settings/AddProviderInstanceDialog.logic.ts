export type AddAccountWizardStep = "Service" | "Name" | "Connect";

/**
 * Steps of the add-account dialog. The dialog is opened from one provider's
 * page, so it never asks which provider. Custom API asks which service and
 * how to reach it; a subscription account only needs a name, and the user
 * signs in from its card afterwards.
 */
export function addAccountWizardSteps(options: {
  readonly choosesService: boolean;
}): readonly AddAccountWizardStep[] {
  return options.choosesService ? ["Service", "Name", "Connect"] : ["Name"];
}

// `ProviderInstanceId` in `@akeru/contracts` caps ids at 64 characters.
const MAX_INSTANCE_ID_LENGTH = 64;

// Room kept for a `_{n}` suffix when the name is already taken.
const SUFFIX_RESERVE = "_99999".length;

/**
 * Normalize a name into the slug part of an account id, so "Work" on driver
 * "codex" becomes `codex_work`. The slug is cut short enough that the driver
 * prefix and a collision suffix still fit the id length cap.
 */
function slugifyLabel(driver: string, value: string): string {
  const maxLength = Math.min(48, MAX_INSTANCE_ID_LENGTH - driver.length - 1 - SUFFIX_RESERVE);

  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLength)
    .replace(/_+$/, "");
}

/** First free `{driver}_{n}` number, starting at 2; the default account is `{driver}`. */
export function nextAccountNumber(driver: string, existing: ReadonlySet<string>): number {
  let index = 2;

  while (existing.has(`${driver}_${index}`)) index += 1;

  return index;
}

/**
 * Account id from the name, or `{driver}_{n}` when the name is empty, with the
 * first free `_{n}` suffix when that id is taken.
 */
export function deriveInstanceId(
  driver: string,
  label: string,
  existing: ReadonlySet<string>,
): string {
  const slug = slugifyLabel(driver, label);

  if (!slug) return `${driver}_${nextAccountNumber(driver, existing)}`;

  const base = `${driver}_${slug}`;

  return existing.has(base) ? `${base}_${nextAccountNumber(base, existing)}` : base;
}

/** Enter that submits, not one that confirms an IME candidate. */
export function isSubmitEnter(event: {
  readonly key: string;
  readonly keyCode: number;
  readonly isComposing: boolean;
}): boolean {
  return event.key === "Enter" && !event.isComposing && event.keyCode !== 229;
}
