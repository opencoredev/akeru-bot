import type { ModelSelection } from "@akeru/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
  providerOptionsForModelChange,
} from "@akeru/shared/model";

import type { ModelOption } from "../../lib/modelOptions";

/** Match the terms a user can actually see or recognize in the model picker. */
export function modelMatchesCatalogQuery(input: {
  readonly model: ModelOption;
  readonly providerLabel: string;
  readonly query: string;
}): boolean {
  const query = input.query.trim().toLocaleLowerCase();

  if (query.length === 0) {
    return true;
  }

  return [
    input.model.label,
    input.model.subtitle,
    input.model.selection.model,
    input.providerLabel,
  ].some((value) => value.toLocaleLowerCase().includes(query));
}

/** Preserve staged provider options when the highlighted model is tapped again. */
export function pendingModelAfterPress(input: {
  readonly current: ModelOption | null;
  readonly pressed: ModelOption;
  readonly pressedIsApplied: boolean;
}): ModelOption | null {
  if (input.pressedIsApplied) {
    return null;
  }

  return input.current?.key === input.pressed.key ? input.current : input.pressed;
}

/**
 * A model staged on the applied model's instance keeps the applied choices it
 * supports, so Save writes the model and those options together. Another
 * instance, or a model with unknown options, starts on its own defaults.
 */
export function stageModelWithAppliedOptions(
  pressed: ModelOption,
  applied: ModelSelection | null,
): ModelOption {
  const carried = providerOptionsForModelChange({
    previous: applied,
    instanceId: pressed.selection.instanceId,
    nextCaps: pressed.capabilities,
  });

  if (!carried || !pressed.capabilities) return pressed;

  const options = buildProviderOptionSelectionsFromDescriptors(
    getProviderOptionDescriptors({ caps: pressed.capabilities, selections: carried }),
  );

  return options ? { ...pressed, selection: { ...pressed.selection, options } } : pressed;
}

/**
 * Primary and selected providers start open; all other catalogs start closed.
 * A user's disclosure tap inverts that default until the picker is dismissed.
 */
export function providerSectionIsCollapsed(input: {
  readonly defaultExpanded: boolean;
  readonly hasExpansionOverride: boolean;
  readonly isNarrowed: boolean;
}): boolean {
  if (input.isNarrowed) {
    return false;
  }

  return input.defaultExpanded ? input.hasExpansionOverride : !input.hasExpansionOverride;
}
