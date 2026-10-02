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

/**
 * Normalize a user-provided name into a slug suffix for the account id.
 * The full id is formed by prefixing the driver slug — e.g. label "Work" on
 * driver "codex" becomes `codex_work`. Output is trimmed to 48 chars so the
 * final composed id stays under the 64-char slug cap enforced by
 * `ProviderInstanceId` in `@akeru/contracts`.
 */
function slugifyLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
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
  const slug = slugifyLabel(label);

  if (!slug) return `${driver}_${nextAccountNumber(driver, existing)}`;

  const base = `${driver}_${slug}`;

  return existing.has(base) ? `${base}_${nextAccountNumber(base, existing)}` : base;
}
