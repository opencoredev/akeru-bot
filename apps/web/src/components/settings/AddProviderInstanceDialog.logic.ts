export type WizardNavigation =
  | { readonly kind: "navigate"; readonly step: number }
  | { readonly kind: "blocked"; readonly step: number; readonly error: string };

export type AddAccountWizardStep = "Service" | "Name" | "Connect" | "Settings";

/**
 * Steps of the add-account dialog. The dialog is opened from one provider's
 * page, so it never asks which provider; Custom API first asks which service,
 * and a provider without settings stops at the name.
 */
export function addAccountWizardSteps(options: {
  readonly choosesService: boolean;
  readonly hasSettings: boolean;
}): readonly AddAccountWizardStep[] {
  if (options.choosesService) return ["Service", "Name", "Connect"];

  return options.hasSettings ? ["Name", "Settings"] : ["Name"];
}

/**
 * Resolve navigation within the add-account wizard.
 *
 * Moving forward past the Name step requires a valid account id, whether the
 * user advances one step at a time or skips ahead from a step header. A
 * blocked skip lands on Name so its inline validation is visible. Backward
 * navigation is always preserved.
 */
export function resolveWizardNavigation(
  currentStep: number,
  requestedStep: number,
  steps: readonly AddAccountWizardStep[],
  validation: { readonly instanceIdError: string | null },
): WizardNavigation {
  const lastStep = Math.max(0, steps.length - 1);
  const targetStep = Math.max(0, Math.min(lastStep, requestedStep));
  const nameStep = steps.indexOf("Name");
  const movesForwardPastName = currentStep <= nameStep && targetStep > nameStep;

  if (movesForwardPastName && validation.instanceIdError !== null) {
    return { kind: "blocked", step: nameStep, error: validation.instanceIdError };
  }

  return { kind: "navigate", step: targetStep };
}
