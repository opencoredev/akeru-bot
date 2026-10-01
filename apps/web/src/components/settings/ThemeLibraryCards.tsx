import { CopyIcon, MoonIcon, PenLineIcon, SunIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { cn } from "../../lib/utils";
import { getThemeModes, type ThemeAppearance, type ThemeDefinition } from "../../themePalette";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { collectionVariantLabels } from "./themeLibrary.logic";
import {
  getThemeCardDefinition,
  ThemePreviewCircle,
  ThemePreviewCircles,
  type ThemeCardDefinition,
  type ThemeMode,
} from "./ThemePreviewCircles";

function ThemeVariantTooltip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

export type ThemeVariantNavigation = {
  collectionLabel: string;
  options: ReadonlyArray<{
    themeIndex: number;
    label: string;
    activeModes: ReadonlyArray<ThemeMode>;
    preview: ThemeCardDefinition["previews"][number];
  }>;
  onSelectAndUse: (themeIndex: number, mode: ThemeAppearance) => void;
};

/**
 * A collection card's light and dark balls. Hovering or focusing a ball fans
 * out that mode's variants; picking one uses it for that mode.
 */
function ThemeVariantRadial({ variantNavigation }: { variantNavigation: ThemeVariantNavigation }) {
  const [radialModeOpen, setRadialModeOpen] = useState<ThemeAppearance | null>(null);

  const radialModeGroups = (["light", "dark"] as const).map((mode) => {
    const options = variantNavigation.options.flatMap((option) => {
      const preview = option.preview;

      return preview.mode === mode ? [{ option, preview }] : [];
    });

    return {
      mode,
      options,
      selected: options.find(({ option }) => option.activeModes.includes(mode)) ?? options[0],
    };
  });

  return (
    <div
      aria-label="Light and dark theme variants"
      className="relative h-20"
      role="group"
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget;

        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
          setRadialModeOpen(null);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") setRadialModeOpen(null);
      }}
      onMouseLeave={() => setRadialModeOpen(null)}
    >
      {radialModeGroups.map(({ mode, options, selected }) => {
        if (!selected) return null;
        // Each mode's root ball sits 52px (ml-13) either side of center.
        const rootOffsetX = mode === "light" ? -52 : 52;
        const rootOffsetClassName = mode === "light" ? "-ml-13" : "ml-13";
        const isOpen = radialModeOpen === mode;
        const isActive = selected.option.activeModes.includes(mode);
        const modeLabel = mode === "light" ? "Light" : "Dark";

        return (
          <div className="contents" key={mode}>
            <ThemeVariantTooltip label={`${modeLabel}: ${selected.option.label}`}>
              <button
                aria-label={
                  options.length > 1
                    ? `Choose ${mode} variant, ${options.length} options, currently ${selected.option.label}`
                    : `Use ${mode} variant, currently ${selected.option.label}`
                }
                aria-pressed={isActive}
                className={cn(
                  "absolute left-1/2 top-2 z-20 flex size-14 -translate-x-1/2 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  rootOffsetClassName,
                )}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  variantNavigation.onSelectAndUse(selected.option.themeIndex, mode);
                }}
                onFocus={() => setRadialModeOpen(mode)}
                onMouseEnter={() => setRadialModeOpen(mode)}
              >
                <ThemePreviewCircle colors={selected.preview.colors} mode={selected.preview.mode} />
                {isActive ? (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-ring"
                  />
                ) : null}
                {isActive ? (
                  <span className="pointer-events-none absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full border border-border/70 bg-card text-foreground shadow-sm">
                    {mode === "light" ? (
                      <SunIcon className="size-2.5" />
                    ) : (
                      <MoonIcon className="size-2.5" />
                    )}
                  </span>
                ) : null}
              </button>
            </ThemeVariantTooltip>
            <span
              className={cn(
                "pointer-events-none absolute bottom-0 left-1/2 inline-flex max-w-24 -translate-x-1/2 items-center gap-1 text-11px font-medium text-foreground",
                rootOffsetClassName,
              )}
            >
              <span className="truncate">{selected.option.label}</span>
              {options.length > 1 ? (
                <span className="shrink-0 rounded-full bg-settings-control px-1 text-9px text-muted-foreground">
                  +{options.length - 1}
                </span>
              ) : null}
            </span>
            {options.length > 1
              ? options.map(({ option, preview }, optionIndex) => {
                  const progress = optionIndex / (options.length - 1) - 0.5;
                  const childOffsetX = rootOffsetX + progress * 68;
                  const childOffsetY = Math.abs(progress) * 10;
                  const optionIsActive = option.activeModes.includes(mode);

                  // Options fan out from the root ball along a shallow arc and
                  // stagger in; closed, they collapse back behind it.
                  /* oxlint-disable shadcn/no-inline-styles -- fan-out arc geometry and stagger are computed per option */
                  const optionStyle: CSSProperties = {
                    transform: `translate(calc(-50% + ${isOpen ? childOffsetX : rootOffsetX}px), ${isOpen ? childOffsetY : 28}px) scale(${isOpen ? 1 : 0.55})`,
                    transitionDelay: isOpen ? `${optionIndex * 35}ms` : "0ms",
                  };

                  /* oxlint-enable shadcn/no-inline-styles */
                  return (
                    <ThemeVariantTooltip
                      key={option.label}
                      label={`Use ${option.label} for ${mode} mode`}
                    >
                      <button
                        aria-label={`Use ${option.label} for ${mode} mode${optionIsActive ? ", currently active" : ""}`}
                        aria-pressed={optionIsActive}
                        className={cn(
                          "absolute left-1/2 top-1 z-30 flex size-7 items-center justify-center rounded-full bg-card shadow-sm outline-none transition-transform-opacity duration-200 ease-out motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring",
                          optionIsActive ? "ring-2 ring-ring" : "ring-1 ring-border/70",
                          isOpen ? "opacity-100" : "pointer-events-none opacity-0",
                        )}
                        style={optionStyle}
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          variantNavigation.onSelectAndUse(option.themeIndex, mode);
                        }}
                        onFocus={() => setRadialModeOpen(mode)}
                        onMouseEnter={() => setRadialModeOpen(mode)}
                      >
                        <span className="pointer-events-none scale-43">
                          <ThemePreviewCircle colors={preview.colors} mode={preview.mode} />
                        </span>
                      </button>
                    </ThemeVariantTooltip>
                  );
                })
              : null}
          </div>
        );
      })}
    </div>
  );
}

export function ThemeLibraryCard({
  theme,
  isActive,
  onUse,
  onUseMode,
  activeModes,
  onEdit,
  onDuplicate,
  onDownload,
  onRemove,
  variantNavigation,
}: {
  theme: ThemeCardDefinition;
  isActive: boolean;
  onUse: () => void;
  onUseMode: (mode: ThemeMode) => void;
  activeModes: ReadonlyArray<ThemeMode>;
  onEdit?: () => void;
  onDuplicate?: () => void;
  onDownload?: () => void;
  onRemove?: () => void;
  variantNavigation?: ThemeVariantNavigation;
}) {
  // A one-appearance theme can only take its own side of the mix, so the card
  // tooltip promises exactly what clicking it does.
  const cardModes = theme.previews.map((preview) => preview.mode);

  return (
    // The card surface stays a plain div (buttons cannot nest inside a button
    // role); the title button and mode circles carry the accessible actions,
    // while the card click is a pointer-only convenience.
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className={cn(
              "cursor-pointer overflow-hidden rounded-xl border bg-settings-surface transition-colors",
              isActive
                ? "border-transparent inset-ring inset-ring-ring"
                : "border-border/70 hover:border-foreground/15",
            )}
            data-theme-library-card={theme.id}
            onClick={onUse}
          >
            <div className="relative">
              {variantNavigation ? (
                <ThemeVariantRadial variantNavigation={variantNavigation} />
              ) : (
                <ThemePreviewCircles
                  label={theme.label}
                  activeModes={activeModes}
                  onSelectMode={onUseMode}
                  previews={theme.previews}
                />
              )}
            </div>
            <div className="flex items-center gap-2 px-3 pb-3 pt-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <button
                    aria-label={`Use ${variantNavigation ? `${variantNavigation.collectionLabel}, ${theme.label} variant` : `${theme.label} theme`}${isActive ? ", currently active" : ""}`}
                    aria-pressed={isActive}
                    className="min-w-0 cursor-pointer truncate rounded-sm text-left text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onUse();
                    }}
                  >
                    {variantNavigation?.collectionLabel ?? theme.label}
                  </button>
                </div>
              </div>
              {onEdit || onDuplicate || onDownload || onRemove ? (
                <div className="flex shrink-0 items-center gap-1">
                  {onDuplicate ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            aria-label={`Duplicate ${theme.label}`}
                            size="icon-xs"
                            variant="ghost"
                            onClick={(event) => {
                              event.stopPropagation();
                              onDuplicate();
                            }}
                          >
                            <CopyIcon />
                          </Button>
                        }
                      />
                      <TooltipPopup>Duplicate theme</TooltipPopup>
                    </Tooltip>
                  ) : null}
                  {onEdit ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            aria-label={`Edit ${theme.label}`}
                            size="icon-xs"
                            variant="ghost"
                            onClick={(event) => {
                              event.stopPropagation();
                              onEdit();
                            }}
                          >
                            <PenLineIcon />
                          </Button>
                        }
                      />
                      <TooltipPopup>Edit theme</TooltipPopup>
                    </Tooltip>
                  ) : null}
                  {onDownload ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            aria-label={`Export ${theme.label}`}
                            size="icon-xs"
                            variant="ghost"
                            onClick={(event) => {
                              event.stopPropagation();
                              onDownload();
                            }}
                          >
                            <UploadIcon />
                          </Button>
                        }
                      />
                      <TooltipPopup>Export theme file</TooltipPopup>
                    </Tooltip>
                  ) : null}
                  {onRemove ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            aria-label={
                              variantNavigation
                                ? `Remove themes from ${variantNavigation.collectionLabel}`
                                : `Remove ${theme.label}`
                            }
                            size="icon-xs"
                            variant="ghost"
                            onClick={(event) => {
                              event.stopPropagation();
                              onRemove();
                            }}
                          >
                            <Trash2Icon />
                          </Button>
                        }
                      />
                      <TooltipPopup>
                        {variantNavigation ? "Remove themes" : "Remove theme"}
                      </TooltipPopup>
                    </Tooltip>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        }
      />
      <TooltipPopup>
        {variantNavigation
          ? "Use the first variants for light and dark"
          : cardModes.length > 1
            ? "Use for both light and dark"
            : `Use for ${cardModes[0]} mode only`}
      </TooltipPopup>
    </Tooltip>
  );
}

export function CustomThemeCollectionCard({
  themes,
  activeModesFor,
  onUse,
  onUseMode,
  onDuplicate,
  onEdit,
  onDownload,
  onRemove,
}: {
  themes: ReadonlyArray<ThemeDefinition>;
  activeModesFor: (themeId: string) => ReadonlyArray<ThemeMode>;
  onUse: (theme: ThemeDefinition) => void;
  onUseMode: (theme: ThemeDefinition, mode: ThemeMode) => void;
  onDuplicate: (theme: ThemeDefinition) => void;
  onEdit: (theme: ThemeDefinition) => void;
  onDownload: (theme: ThemeDefinition) => void;
  onRemove: (theme: ThemeDefinition) => void;
}) {
  const [variantIndex, setVariantIndex] = useState(() => {
    const activeIndex = themes.findIndex((theme) => activeModesFor(theme.id).length > 0);

    return activeIndex < 0 ? 0 : activeIndex;
  });

  const safeIndex = Math.min(variantIndex, themes.length - 1);
  const theme = themes[safeIndex];

  useEffect(() => {
    if (variantIndex !== safeIndex) setVariantIndex(safeIndex);
  }, [safeIndex, variantIndex]);

  if (!theme) return null;
  const collectionLabel = theme.collection?.label ?? theme.label;
  const variantLabels = collectionVariantLabels(themes);
  const defaultLightTheme = themes.find((candidate) => getThemeModes(candidate).includes("light"));
  const defaultDarkTheme = themes.find((candidate) => getThemeModes(candidate).includes("dark"));

  const selectCollectionDefaults = () => {
    if (themes.length === 1) {
      onUse(theme);

      return;
    }

    if (defaultLightTheme) onUseMode(defaultLightTheme, "light");

    if (defaultDarkTheme) onUseMode(defaultDarkTheme, "dark");
    setVariantIndex(0);
  };

  return (
    <ThemeLibraryCard
      activeModes={activeModesFor(theme.id)}
      isActive={false}
      onDownload={() => onDownload(theme)}
      onDuplicate={() => onDuplicate(theme)}
      onEdit={() => onEdit(theme)}
      onRemove={() => onRemove(theme)}
      onUse={selectCollectionDefaults}
      onUseMode={(mode) => onUseMode(theme, mode)}
      theme={getThemeCardDefinition(theme)}
      {...(themes.length > 1
        ? {
            variantNavigation: {
              collectionLabel,
              options: themes.flatMap((variant, themeIndex) =>
                getThemeCardDefinition(variant).previews.map((preview) => ({
                  themeIndex,
                  label: variantLabels[themeIndex] ?? variant.label,
                  activeModes: activeModesFor(variant.id),
                  preview,
                })),
              ),
              onSelectAndUse: (themeIndex, mode) => {
                const selectedTheme = themes[themeIndex];

                if (!selectedTheme) return;
                setVariantIndex(themeIndex);
                onUseMode(selectedTheme, mode);
              },
            },
          }
        : {})}
    />
  );
}
