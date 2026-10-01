import { Predicate } from "effect";
import type {
  ModelCapabilities,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
} from "@akeru/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
  getProviderOptionDescriptors,
} from "@akeru/shared/model";

export function resolveProviderOptionDescriptors(input: {
  readonly capabilities: ModelCapabilities | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): ReadonlyArray<ProviderOptionDescriptor> {
  if (!input.capabilities) {
    return [];
  }

  return getProviderOptionDescriptors({
    caps: input.capabilities,
    selections: input.selections,
  });
}

/**
 * Labels for the option values currently in effect (select values plus
 * enabled booleans), used to summarize the thread configuration in the
 * composer trigger pill.
 */
export function providerOptionValueLabels(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ReadonlyArray<string> {
  return descriptors.flatMap((descriptor) => {
    if (descriptor.type === "boolean") {
      return descriptor.currentValue ? [descriptor.label] : [];
    }

    const label = getProviderOptionCurrentLabel(descriptor);

    return label ? [label] : [];
  });
}

/**
 * Applies one option change (by descriptor id) and returns the full selection
 * list to store on the model selection, or null when the change doesn't match
 * an advertised descriptor / choice.
 */
export function applyProviderOptionSelection(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  change: ProviderOptionSelection,
): ReadonlyArray<ProviderOptionSelection> | null {
  const descriptor = descriptors.find((candidate) => candidate.id === change.id);

  if (!descriptor) {
    return null;
  }

  if (
    (descriptor.type === "boolean" && !Predicate.isBoolean(change.value)) ||
    (descriptor.type === "select" &&
      (!Predicate.isString(change.value) ||
        !descriptor.options.some((option) => option.id === change.value)))
  ) {
    return null;
  }

  const nextDescriptors = descriptors.map((candidate) =>
    candidate.id !== descriptor.id
      ? candidate
      : candidate.type === "boolean"
        ? {
            ...candidate,
            currentValue: Predicate.isBoolean(change.value) ? change.value : candidate.currentValue,
          }
        : {
            ...candidate,
            currentValue: Predicate.isString(change.value) ? change.value : candidate.currentValue,
          },
  );

  return buildProviderOptionSelectionsFromDescriptors(nextDescriptors) ?? [];
}
