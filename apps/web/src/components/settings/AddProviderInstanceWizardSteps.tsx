import { Button } from "../ui/button";
import { CheckIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import {
  resolveWizardNavigation,
  type AddAccountWizardStep,
  type WizardNavigation,
} from "./AddProviderInstanceDialog.logic";

interface AddProviderInstanceWizardStepsProps {
  readonly steps: readonly AddAccountWizardStep[];
  readonly currentStep: number;
  readonly summaries: readonly (string | null)[];
  readonly instanceIdError: string | null;
  readonly onNavigation: (navigation: WizardNavigation) => void;
}

export function AddProviderInstanceWizardSteps({
  steps,
  currentStep,
  summaries,
  instanceIdError,
  onNavigation,
}: AddProviderInstanceWizardStepsProps) {
  return (
    <ol
      className="grid grid-cols-3 gap-1 rounded-xl bg-inset-surface p-1 ring-1 ring-tint/5"
      role="list"
    >
      {steps.map((step, index) => (
        <li key={step} className="min-w-0">
          <Button
            type="button"
            unstyled
            presentation={index === currentStep ? "wizard-step-current" : "wizard-step"}
            aria-current={index === currentStep ? "step" : undefined}
            aria-label={`${step}, step ${index + 1}${index < currentStep && summaries[index] ? `, ${summaries[index]}` : ""}`}
            onClick={() =>
              onNavigation(resolveWizardNavigation(currentStep, index, steps, { instanceIdError }))
            }
          >
            <span
              className={cn(
                "grid size-5 shrink-0 place-items-center rounded-full text-sm font-medium ring-1",
                index < currentStep
                  ? "bg-primary text-primary-foreground ring-primary"
                  : index === currentStep
                    ? "bg-primary/10 text-primary ring-primary/30"
                    : "bg-card text-muted-foreground ring-tint/10 dark:bg-tint/5",
              )}
              aria-hidden
            >
              {index < currentStep ? <CheckIcon className="size-4 shrink-0" /> : index + 1}
            </span>
            <span
              className={cn(
                "min-w-0 truncate text-sm font-medium max-sm:hidden",
                index === currentStep ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {step}
            </span>
          </Button>
        </li>
      ))}
    </ol>
  );
}
