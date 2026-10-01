import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ServerProviderModel,
} from "@akeru/contracts";
import {
  applyClaudePromptEffortPrefix,
  buildProviderOptionSelectionsFromDescriptors,
} from "@akeru/shared/model";
import type { VariantProps } from "class-variance-authority";
import { memo, useCallback } from "react";
import { useI18n } from "~/i18n";
import { useComposerDraftStore } from "../../composerDraftStore";
import { Badge } from "../ui/badge";
import { buttonVariants } from "../ui/button";
import { MenuSeparator as MenuDivider, MenuGroup, MenuRadioGroup, MenuRadioItem } from "../ui/menu";
import {
  type ProviderOptions,
  type TraitsPersistence,
  ULTRATHINK_PROMPT_PREFIX,
  getDescriptorStringValue,
  getTraitsSectionVisibility,
  replaceDescriptorCurrentValue,
} from "./traitsPicker.logic";

function DefaultBadge() {
  const { t } = useI18n();

  return (
    <Badge
      variant="outline"
      presentation="default-trait"
      className="inline-flex h-4 w-fit min-w-0 items-center justify-center sm:h-4"
    >
      {t("Default")}
    </Badge>
  );
}

export interface TraitsMenuContentProps {
  provider: ProviderDriverKind;
  instanceId?: ProviderInstanceId;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  modelOptions?: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
}

export const TraitsMenuContent = memo(function TraitsMenuContentImpl({
  provider,
  instanceId,
  models,
  model,
  prompt,
  onPromptChange,
  modelOptions,
  allowPromptInjectedEffort = true,
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence) {
  const { t } = useI18n();
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);

  const updateModelOptions = useCallback(
    (nextOptions: ProviderOptions | undefined) => {
      if ("onModelOptionsChange" in persistence) {
        persistence.onModelOptionsChange(nextOptions);

        return;
      }

      const threadTarget = persistence.threadRef ?? persistence.draftId;

      if (!threadTarget) {
        return;
      }

      setProviderModelOptions(threadTarget, provider, nextOptions, {
        ...(instanceId ? { instanceId } : {}),
        model,
        persistSticky: true,
      });
    },
    [instanceId, model, persistence, provider, setProviderModelOptions],
  );

  const {
    descriptors,
    selectDescriptors,
    booleanDescriptors,
    primarySelectDescriptor,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
    hasAnyControls,
  } = getTraitsSectionVisibility({
    provider,
    models,
    model,
    prompt,
    modelOptions,
    allowPromptInjectedEffort,
  });

  const updateDescriptors = (nextDescriptors: ReadonlyArray<ProviderOptionDescriptor>) => {
    updateModelOptions(buildProviderOptionSelectionsFromDescriptors(nextDescriptors));
  };

  const handleSelectChange = (
    descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
    value: string,
  ) => {
    if (!value) return;

    if (descriptor.promptInjectedValues?.includes(value)) {
      const nextPrompt =
        prompt.trim().length === 0
          ? ULTRATHINK_PROMPT_PREFIX
          : applyClaudePromptEffortPrefix(prompt, "ultrathink");

      onPromptChange(nextPrompt);

      return;
    }

    if (ultrathinkInBodyText && descriptor.id === primarySelectDescriptor?.id) return;

    if (ultrathinkPromptControlled && descriptor.id === primarySelectDescriptor?.id) {
      const stripped = prompt.replace(/^Ultrathink:\s*/i, "");
      onPromptChange(stripped);
    }

    updateDescriptors(replaceDescriptorCurrentValue(descriptors, descriptor.id, value));
  };

  if (!hasAnyControls) {
    return null;
  }

  return (
    <>
      {selectDescriptors.map((descriptor, index) => {
        const selectedValue =
          ultrathinkPromptControlled && descriptor.id === primarySelectDescriptor?.id
            ? "ultrathink"
            : (getDescriptorStringValue(descriptor) ?? "");

        return (
          <div key={descriptor.id}>
            {index > 0 ? <MenuDivider /> : null}
            <MenuGroup>
              <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
                {descriptor.label}
              </div>
              {ultrathinkInBodyText && descriptor.id === primarySelectDescriptor?.id ? (
                <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">
                  {t(
                    "Your prompt contains {keyword} in the text. Remove it to change this option.",
                    { keyword: '"ultrathink"' },
                  )}
                </div>
              ) : null}
              <MenuRadioGroup
                value={selectedValue}
                onValueChange={(value) => handleSelectChange(descriptor, value)}
              >
                {descriptor.options.flatMap((option) =>
                  allowPromptInjectedEffort || !descriptor.promptInjectedValues?.includes(option.id)
                    ? [
                        <MenuRadioItem
                          key={option.id}
                          value={option.id}
                          hideIndicator
                          // Base UI keeps radio menus open by default. Close on pick so
                          // the traits menu behaves like the model picker.
                          closeOnClick
                          disabled={
                            ultrathinkInBodyText && descriptor.id === primarySelectDescriptor?.id
                          }
                        >
                          <span className="flex w-full min-w-0 flex-col">
                            <span className="flex w-full min-w-0 items-center justify-between gap-3">
                              <span className="min-w-0 truncate">
                                {option.label}
                                {option.isDefault ? (
                                  <>
                                    {" "}
                                    <DefaultBadge />
                                  </>
                                ) : null}
                              </span>
                            </span>
                            {option.description ? (
                              <span className="max-w-56 text-pretty text-muted-foreground/80 text-xs">
                                {option.description}
                              </span>
                            ) : null}
                          </span>
                        </MenuRadioItem>,
                      ]
                    : [],
                )}
              </MenuRadioGroup>
            </MenuGroup>
          </div>
        );
      })}
      {booleanDescriptors.map((descriptor, index) => {
        const selectedValue = descriptor.currentValue === true ? "on" : "off";

        return (
          <div key={descriptor.id}>
            {index > 0 || selectDescriptors.length > 0 ? <MenuDivider /> : null}
            <MenuGroup>
              <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
                {descriptor.label}
              </div>
              <MenuRadioGroup
                value={selectedValue}
                onValueChange={(value) => {
                  updateDescriptors(
                    replaceDescriptorCurrentValue(descriptors, descriptor.id, value === "on"),
                  );
                }}
              >
                {(["on", "off"] as const).map((value) => (
                  <MenuRadioItem key={value} value={value} hideIndicator closeOnClick>
                    <span className="flex w-full min-w-0 items-center justify-between gap-3">
                      <span>{value === "on" ? t("On") : t("Off")}</span>
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </div>
        );
      })}
    </>
  );
});
