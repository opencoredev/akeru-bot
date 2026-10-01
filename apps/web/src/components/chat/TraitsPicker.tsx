import { ZapIcon } from "lucide-react";
import { memo, useState } from "react";
import { useI18n } from "~/i18n";
import { cn } from "~/lib/utils";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { ComposerControl, ComposerControlChevron, ComposerControlIcon } from "./ComposerControl";
import { type TraitsMenuContentProps, TraitsMenuContent } from "./TraitsMenuContent";
import {
  type TraitsPersistence,
  buildTraitsTriggerDisplay,
  getTraitsSectionVisibility,
  shouldRenderTraitsControls,
} from "./traitsPicker.logic";

export const TraitsPicker = memo(function TraitsPicker({
  provider,
  instanceId,
  models,
  model,
  prompt,
  onPromptChange,
  modelOptions,
  allowPromptInjectedEffort = true,
  triggerVariant,
  triggerClassName,
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence) {
  const { t } = useI18n();
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const { descriptors, primarySelectDescriptor, ultrathinkPromptControlled } =
    getTraitsSectionVisibility({
      provider,
      models,
      model,
      prompt,
      modelOptions,
      allowPromptInjectedEffort,
    });

  if (
    !shouldRenderTraitsControls({
      provider,
      models,
      model,
      prompt,
      modelOptions,
      allowPromptInjectedEffort,
    })
  ) {
    return null;
  }

  const { label: triggerLabel, showFastModeIcon } = buildTraitsTriggerDisplay({
    provider,
    descriptors,
    primarySelectDescriptorId: primarySelectDescriptor?.id ?? null,
    ultrathinkPromptControlled,
    t,
  });

  const fastModeIcon = showFastModeIcon ? (
    <>
      <ComposerControlIcon
        icon={ZapIcon}
        className={cn(
          "fill-current opacity-80",
          provider === "claudeAgent" ? "text-[#d97757]" : "text-foreground",
        )}
      />
      <span className="sr-only">{t("Fast mode on")}</span>
    </>
  ) : null;

  const isCodexStyle = provider === "codex";

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <ComposerControl
            variant={triggerVariant ?? "ghost"}
            className={cn(
              isCodexStyle
                ? "min-w-0 max-w-40 shrink justify-start overflow-hidden whitespace-nowrap sm:max-w-48"
                : "shrink-0 whitespace-nowrap",
              triggerClassName,
            )}
          />
        }
      >
        {isCodexStyle ? (
          <span className="flex min-w-0 w-full items-center gap-1.5 overflow-hidden">
            {fastModeIcon}
            <span className="min-w-0 truncate">{triggerLabel}</span>
            <ComposerControlChevron />
          </span>
        ) : (
          <>
            {fastModeIcon}
            <span>{triggerLabel}</span>
            <ComposerControlChevron />
          </>
        )}
      </MenuTrigger>
      <MenuPopup align="start">
        <TraitsMenuContent
          provider={provider}
          {...(instanceId ? { instanceId } : {})}
          models={models}
          model={model}
          prompt={prompt}
          onPromptChange={onPromptChange}
          modelOptions={modelOptions}
          allowPromptInjectedEffort={allowPromptInjectedEffort}
          {...persistence}
        />
      </MenuPopup>
    </Menu>
  );
});

export { TraitsMenuContent, type TraitsMenuContentProps } from "./TraitsMenuContent";

export { buildTraitsTriggerDisplay, shouldRenderTraitsControls } from "./traitsPicker.logic";
