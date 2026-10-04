import { Children, isValidElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { addAccountWizardSteps } from "./AddProviderInstanceDialog.logic";
import { AddProviderInstanceWizardSteps } from "./AddProviderInstanceWizardSteps";

interface StepButtonProps {
  readonly "aria-current"?: string;
  readonly onClick: () => void;
}

interface StepListItemProps {
  readonly children: ReactElement<StepButtonProps>;
}

const CUSTOM_API_STEPS = addAccountWizardSteps({ choosesService: true });

function renderStepButtons(
  currentStep: number,
  onStepChange: (step: number) => void,
): ReactElement<StepButtonProps>[] {
  const header = AddProviderInstanceWizardSteps({
    steps: CUSTOM_API_STEPS,
    currentStep,
    summaries: ["OpenRouter", "OpenRouter", null],
    onStepChange,
  });

  return Children.toArray(header.props.children)
    .filter((child): child is ReactElement<StepListItemProps> => isValidElement(child))
    .map((item) => item.props.children);
}

describe("AddProviderInstanceWizardSteps", () => {
  it("moves to the clicked step in either direction", () => {
    const onStepChange = vi.fn();
    const buttons = renderStepButtons(1, onStepChange);

    expect(buttons).toHaveLength(CUSTOM_API_STEPS.length);
    buttons[2]!.props.onClick();
    buttons[0]!.props.onClick();

    expect(onStepChange.mock.calls).toEqual([[2], [0]]);
  });

  it("marks the wizard step separately from the clicked button focus", () => {
    const buttons = renderStepButtons(1, vi.fn());

    expect(buttons[0]!.props["aria-current"]).toBeUndefined();
    expect(buttons[1]!.props["aria-current"]).toBe("step");
    expect(buttons[2]!.props["aria-current"]).toBeUndefined();
  });
});
