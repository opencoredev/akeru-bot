import {
  ChevronDownIcon,
  ChevronUpIcon,
  MousePointer2Icon,
  PaintbrushIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  applyThemeColorPreview,
  THEME_FILE_VERSION,
  getCustomThemes,
  getThemeColorsForMode,
  getThemeModes,
  installCustomTheme,
  parseThemeFile,
  removeCustomTheme,
  themeIdFromName,
  updateThemeColorFamily,
  updateCustomTheme,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeDefinition,
} from "../../themePalette";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { getThemeRoleLabel } from "./themeColorPicker.logic";
import {
  ThemeEditorAppearanceField,
  ThemeEditorColorFields,
  ThemeEditorColorsHeader,
  ThemeEditorNameField,
} from "./ThemeEditorFields";
import {
  getManagedEditorColors,
  getThemeEditorColorsByAppearance,
  getThemeEditorRoleLabel,
  isThemeEditorColor,
  THEME_EDITOR_SIMPLE_ROLES,
  type ThemeEditorColorsByAppearance,
} from "./themeEditorRoles";
import { useThemeEditorGeometry } from "./useThemeEditorGeometry";
import { useThemeEditorInspector } from "./useThemeEditorInspector";

export function ThemeEditorPanel({
  open,
  onOpenChange,
  onSaved,
  editingTheme,
  initialAppearance,
  seedTheme,
  seedName,
  restoreTheme,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (
    theme: ThemeDefinition,
    context: {
      created: boolean;
      /** Set when a create merged its palette into an existing theme. */
      mergedAppearance?: ThemeAppearance;
    },
  ) => boolean;
  editingTheme: ThemeDefinition | null;
  initialAppearance: ThemeAppearance;
  /** The theme a new theme starts from, so tuning what you already use is a
   *  matter of editing rather than rebuilding. Null starts from the defaults. */
  seedTheme?: ThemeDefinition | null;
  /** Prefilled name for an explicit duplicate; a plain create stays unnamed. */
  seedName?: string | undefined;
  /** Reapplies the stored theme once the draft stops being previewed. */
  restoreTheme: () => void;
}) {
  const isEditing = editingTheme !== null;
  const [name, setName] = useState("");
  const [activeAppearance, setActiveAppearance] = useState<ThemeAppearance>(initialAppearance);
  const [isAdvanced, setIsAdvanced] = useState(false);

  const [colorsByAppearance, setColorsByAppearance] = useState<ThemeEditorColorsByAppearance>(() =>
    getThemeEditorColorsByAppearance(),
  );

  const [simpleColorsDirtyByAppearance, setSimpleColorsDirtyByAppearance] = useState<
    Record<ThemeAppearance, boolean>
  >({ light: false, dark: false });

  const [error, setError] = useState<string | null>(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [roleQuery, setRoleQuery] = useState("");

  const { panelRef, position, size, dragHandlers, resizeHandlers } = useThemeEditorGeometry({
    open,
    isMinimized,
  });

  // Picking a role only advanced mode can edit switches to advanced mode with
  // an unfiltered list, so the picked field is on screen.
  const revealAdvancedRole = useCallback(() => {
    setIsAdvanced(true);
    setRoleQuery("");
  }, []);

  const {
    isInspecting,
    setIsInspecting,
    selectedRole,
    setSelectedRole,
    usageCount,
    selectThemeRole,
    toggleThemeRole,
    clearInspectorSelection,
  } = useThemeEditorInspector({
    open,
    isAdvanced,
    activeColors: colorsByAppearance[activeAppearance],
    panelRef,
    onRevealAdvancedRole: revealAdvancedRole,
  });

  // The draft only reaches the live app once this open has been seeded;
  // previewing in the seeding commit would paint the previous session's
  // colors for a frame.
  const [isDraftSeeded, setIsDraftSeeded] = useState(false);
  const previousOpenRef = useRef(false);

  useEffect(() => {
    if (open && !previousOpenRef.current) {
      // Editing works on the theme itself; creating starts from the theme
      // that is currently in use, so tuning what you already run is an edit
      // away instead of a rebuild from the defaults.
      const sourceTheme = editingTheme ?? seedTheme ?? null;
      const nextColors = getThemeEditorColorsByAppearance();

      const nextAppearance = sourceTheme
        ? getThemeColorsForMode(sourceTheme, initialAppearance)
          ? initialAppearance
          : sourceTheme.appearance
        : initialAppearance;

      if (sourceTheme) {
        nextColors[sourceTheme.appearance] = { ...sourceTheme.colors };

        for (const appearance of ["light", "dark"] as const) {
          const variantColors = sourceTheme.variants?.[appearance];

          if (variantColors) nextColors[appearance] = { ...variantColors };
        }
      }

      setName(editingTheme?.label ?? seedName ?? "");
      setActiveAppearance(nextAppearance);
      // Themes saved by the guided editor carry the managed flag; anything
      // else (imports, hand-edited files, older saves) opens in advanced mode
      // so guided regeneration cannot silently discard hand-tuned colors. A
      // seeded new theme follows the same rule: its palette is only safe to
      // regenerate when the guided editor produced it.
      setIsAdvanced(sourceTheme !== null && sourceTheme.managed !== true);
      setSimpleColorsDirtyByAppearance({ light: false, dark: false });
      setColorsByAppearance(nextColors);
      clearInspectorSelection();
      setError(null);
      setIsDraftSeeded(true);
    }

    if (!open && isDraftSeeded) setIsDraftSeeded(false);
    previousOpenRef.current = open;
  }, [
    clearInspectorSelection,
    editingTheme,
    initialAppearance,
    isDraftSeeded,
    open,
    seedName,
    seedTheme,
  ]);

  // A name an installed theme already uses combines instead of failing:
  // creating adds the new palette to that theme, and renaming an existing
  // theme onto it folds the edited palette in and retires the old entry —
  // light "My Theme" plus a dark "My Theme" become one theme with both modes.
  // Labels are matched as well as derived ids: a rename keeps a theme's
  // original id, so its label is the only name a user can see and retype.
  const nameTargetId = themeIdFromName(name);
  const normalizedName = name.trim().toLowerCase();

  const mergeTarget =
    normalizedName === ""
      ? null
      : (getCustomThemes().find(
          (theme) =>
            theme.id !== editingTheme?.id &&
            (theme.id === nameTargetId || theme.label.trim().toLowerCase() === normalizedName),
        ) ?? null);

  const takenAppearances = mergeTarget ? getThemeModes(mergeTarget) : [];
  const editableAppearances = editingTheme ? getThemeModes(editingTheme) : null;

  // The appearance a mode button would produce can be blocked two ways: the
  // merge target already has that palette, or the theme being edited never
  // had it (adding one is a create-with-same-name away).
  const appearanceLockReason = (appearance: ThemeAppearance): string | null => {
    if (editableAppearances && !editableAppearances.includes(appearance)) {
      return `“${editingTheme?.label}” has no ${appearance} palette. Create a theme with the same name to add one.`;
    }

    if (!isEditing && takenAppearances.includes(appearance)) {
      return `“${mergeTarget?.label}” already has a ${appearance} palette.`;
    }

    return null;
  };

  // Typing a name whose theme already owns the selected appearance flips the
  // draft to the free side, so the merge affordance works without a manual
  // toggle. Both sides taken leaves the selection alone; save is blocked with
  // an explanation instead.
  const mergeTargetId = mergeTarget?.id ?? null;
  const takenAppearancesKey = takenAppearances.join(",");
  useEffect(() => {
    if (isEditing || mergeTargetId === null) return;

    const taken = takenAppearancesKey
      .split(",")
      .filter((value): value is ThemeAppearance => value === "light" || value === "dark");

    if (taken.length !== 1) return;
    setActiveAppearance((current) => {
      if (!taken.includes(current)) return current;

      return taken[0] === "light" ? "dark" : "light";
    });
  }, [isEditing, mergeTargetId, takenAppearancesKey]);

  // The whole app wears the draft while the editor is open, so a role change
  // is judged on the real interface rather than a miniature. The stored theme
  // comes back when the editor closes, including on cancel.
  useEffect(() => {
    if (!open || !isDraftSeeded) return;
    applyThemeColorPreview(colorsByAppearance[activeAppearance], activeAppearance);
  }, [activeAppearance, colorsByAppearance, isDraftSeeded, open]);

  useEffect(() => {
    if (!open) return;

    return () => {
      restoreTheme();
    };
  }, [open, restoreTheme]);

  const updateColor = useCallback(
    (role: ThemeColorRole, value: string) => {
      setColorsByAppearance((current) => {
        const nextColors = { ...current[activeAppearance], [role]: value };

        const shouldManageColors =
          !isAdvanced && THEME_EDITOR_SIMPLE_ROLES.includes(role) && isThemeEditorColor(value);

        return {
          ...current,
          [activeAppearance]: isAdvanced
            ? updateThemeColorFamily(activeAppearance, current[activeAppearance], role, value)
            : shouldManageColors
              ? getManagedEditorColors(activeAppearance, nextColors)
              : nextColors,
        };
      });

      if (!isAdvanced && THEME_EDITOR_SIMPLE_ROLES.includes(role) && isThemeEditorColor(value)) {
        setSimpleColorsDirtyByAppearance((current) => ({
          ...current,
          [activeAppearance]: true,
        }));
      }
    },
    [activeAppearance, isAdvanced],
  );

  const handleAdvancedChange = useCallback(
    (checked: boolean) => {
      setIsAdvanced(checked);

      if (checked) return;

      if (selectedRole && !THEME_EDITOR_SIMPLE_ROLES.includes(selectedRole)) {
        setSelectedRole(null);
      }

      // Regenerate every appearance the theme will save, not just the visible
      // one, so the palettes shown after toggling match what gets saved.
      const managedAppearances: ReadonlyArray<ThemeAppearance> =
        editingTheme && getThemeModes(editingTheme).length > 1
          ? ["light", "dark"]
          : [activeAppearance];

      setSimpleColorsDirtyByAppearance((current) => {
        const next = { ...current };

        for (const appearance of managedAppearances) next[appearance] = true;

        return next;
      });
      setColorsByAppearance((current) => {
        const next = { ...current };

        for (const appearance of managedAppearances) {
          next[appearance] = getManagedEditorColors(appearance, current[appearance]);
        }

        return next;
      });
    },
    [activeAppearance, editingTheme, selectedRole],
  );

  const handleSubmit = () => {
    if (!name.trim()) {
      setError("Name your theme first.");

      return;
    }

    try {
      // Only regenerate palettes the user actually touched in guided mode, so
      // untouched appearances save exactly what the editor displayed.
      const colorsForSave = !isAdvanced
        ? {
            light: simpleColorsDirtyByAppearance.light
              ? getManagedEditorColors("light", colorsByAppearance.light)
              : colorsByAppearance.light,
            dark: simpleColorsDirtyByAppearance.dark
              ? getManagedEditorColors("dark", colorsByAppearance.dark)
              : colorsByAppearance.dark,
          }
        : colorsByAppearance;

      let savedTheme: ThemeDefinition;
      let mergedAppearance: ThemeAppearance | null = null;
      let retiredTheme: ThemeDefinition | null = null;

      if (editingTheme && mergeTarget) {
        // Renamed onto another installed theme: this theme's palettes fold
        // into it and the edited entry retires, so both cards become one.
        // Colliding palettes cannot merge — neither side should be silently
        // overwritten.
        const editedModes = getThemeModes(editingTheme);
        const collision = editedModes.find((mode) => takenAppearances.includes(mode));

        if (collision) {
          setError(`“${mergeTarget.label}” already has a ${collision} palette. Pick another name.`);

          return;
        }

        mergedAppearance = editedModes[0] ?? null;
        savedTheme = updateCustomTheme({
          ...parseThemeFile({
            version: THEME_FILE_VERSION,
            id: mergeTarget.id,
            name: mergeTarget.label,
            appearance: mergeTarget.appearance,
            colors: mergeTarget.colors,
            variants: {
              ...mergeTarget.variants,
              ...Object.fromEntries(editedModes.map((mode) => [mode, colorsForSave[mode]])),
            },
            ...(mergeTarget.managed === true && !isAdvanced ? { managed: true } : {}),
          }),
          ...(mergeTarget.collection ? { collection: mergeTarget.collection } : {}),
        });
        retiredTheme = editingTheme;

        try {
          removeCustomTheme(editingTheme.id);
        } catch (cause) {
          // The merge already persisted. Leaving it while the edited theme
          // survives would collide on every retry, so the target goes back to
          // its pre-merge palettes before the failure surfaces.
          try {
            updateCustomTheme(mergeTarget);
          } catch {
            // Storage is failing wholesale; the rethrow below reports it.
          }

          throw cause;
        }
      } else if (editingTheme) {
        const baseAppearance = editingTheme.appearance;
        const variantAppearance = baseAppearance === "light" ? "dark" : "light";
        savedTheme = updateCustomTheme({
          ...parseThemeFile({
            version: THEME_FILE_VERSION,
            id: editingTheme.id,
            name,
            appearance: baseAppearance,
            colors: colorsForSave[baseAppearance],
            ...(getThemeModes(editingTheme).length > 1
              ? { variants: { [variantAppearance]: colorsForSave[variantAppearance] } }
              : {}),
            ...(isAdvanced ? {} : { managed: true }),
          }),
          ...(editingTheme.collection ? { collection: editingTheme.collection } : {}),
        });
      } else if (mergeTarget) {
        if (takenAppearances.includes(activeAppearance)) {
          setError(
            `“${mergeTarget.label}” already has light and dark palettes. Pick another name.`,
          );

          return;
        }

        // The new palette joins the existing theme as its other mode; its
        // stored palettes are untouched. The guided (managed) flag only
        // survives when every palette in the theme came from the guided
        // editor.
        mergedAppearance = activeAppearance;
        savedTheme = updateCustomTheme({
          ...parseThemeFile({
            version: THEME_FILE_VERSION,
            id: mergeTarget.id,
            name: mergeTarget.label,
            appearance: mergeTarget.appearance,
            colors: mergeTarget.colors,
            variants: {
              ...mergeTarget.variants,
              [activeAppearance]: colorsForSave[activeAppearance],
            },
            ...(mergeTarget.managed === true && !isAdvanced ? { managed: true } : {}),
          }),
          ...(mergeTarget.collection ? { collection: mergeTarget.collection } : {}),
        });
      } else {
        savedTheme = installCustomTheme(
          parseThemeFile({
            version: THEME_FILE_VERSION,
            name,
            appearance: activeAppearance,
            colors: colorsForSave[activeAppearance],
            ...(isAdvanced ? {} : { managed: true }),
          }),
        );
      }

      if (
        !onSaved(savedTheme, {
          created: editingTheme === null && mergedAppearance === null,
          ...(mergedAppearance ? { mergedAppearance } : {}),
        })
      ) {
        if (!editingTheme && mergedAppearance === null) {
          // Roll the install back so a retry can run it again instead of
          // failing on the already-taken theme id.
          try {
            removeCustomTheme(savedTheme.id);
          } catch {
            // Storage is failing wholesale; the error below covers it.
          }
        } else if (mergeTarget && mergedAppearance !== null) {
          // Put the pre-merge definitions back for the same reason.
          try {
            updateCustomTheme(mergeTarget);

            if (retiredTheme) installCustomTheme(retiredTheme);
          } catch {
            // Storage is failing wholesale; the error below covers it.
          }
        }

        setError("Theme saved, but it could not be made active. Try again.");

        return;
      }

      onOpenChange(false);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : isEditing
            ? "Could not save the theme."
            : "Could not create the theme.",
      );
    }
  };

  /* oxlint-disable shadcn/no-inline-styles -- dragged position and resized size are runtime geometry */
  const panelStyle: CSSProperties = {
    ...(position ? { left: position.x, top: position.y } : {}),
    ...(size ? { width: size.width } : {}),
    // A chosen height only applies expanded; minimized keeps hugging the
    // header. The viewport stays the ceiling either way.
    ...(size && !isMinimized ? { height: size.height, maxHeight: "calc(100dvh - 1rem)" } : {}),
  };
  /* oxlint-enable shadcn/no-inline-styles */

  return (
    <div
      aria-label={isEditing ? "Edit theme" : "Create theme"}
      className={cn(
        "dialog-glass fixed z-110 flex max-h-[min(42rem,calc(100dvh-6rem))] w-[min(26rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border text-popover-foreground",
        position === null && "bottom-4 right-4",
        isMinimized && "max-h-none",
      )}
      data-theme-editor-panel
      ref={panelRef}
      role="dialog"
      style={panelStyle}
    >
      <div
        className="flex cursor-grab touch-none select-none items-center gap-1 border-b border-border/70 px-3 py-2 active:cursor-grabbing"
        {...dragHandlers}
      >
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <h2 className="shrink-0 truncate text-sm font-medium">
            {isEditing ? "Edit theme" : "Create theme"}
          </h2>
          {isMinimized ? null : (
            <p className="truncate text-xs text-muted-foreground">
              {isInspecting
                ? "Select an element · Esc to cancel"
                : selectedRole
                  ? `${isAdvanced ? getThemeEditorRoleLabel(selectedRole) : getThemeRoleLabel(selectedRole)} · ${usageCount ?? 0} ${usageCount === 1 ? "use" : "uses"}`
                  : "Select a color below"}
            </p>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={isInspecting ? "Cancel inspecting app colors" : "Inspect app colors"}
                aria-pressed={isInspecting}
                size="xs"
                variant={isInspecting ? "secondary" : "ghost"}
                onClick={() => {
                  if (isInspecting) {
                    clearInspectorSelection();

                    return;
                  }

                  setIsInspecting(true);
                }}
              >
                <MousePointer2Icon />
                {isInspecting ? "Cancel" : "Inspect"}
              </Button>
            }
          />
          <TooltipPopup data-theme-editor-panel="">
            {isInspecting ? "Cancel and clear the selection" : "Pick a color from the app"}
          </TooltipPopup>
        </Tooltip>
        <Button
          aria-label={isMinimized ? "Expand the theme editor" : "Minimize the theme editor"}
          size="icon-xs"
          variant="ghost"
          onClick={() => setIsMinimized(!isMinimized)}
        >
          {isMinimized ? <ChevronUpIcon /> : <ChevronDownIcon />}
        </Button>
        <Button
          aria-label="Close the theme editor"
          size="icon-xs"
          variant="ghost"
          onClick={() => onOpenChange(false)}
        >
          <XIcon />
        </Button>
      </div>

      {isMinimized ? null : (
        <>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto py-3 pl-3 pr-1.5">
            <ThemeEditorNameField
              isEditing={isEditing}
              name={name}
              onNameChange={(nextName) => {
                setName(nextName);
                // Most save failures are name collisions; retyping is the fix,
                // so the stale message goes with the old name.
                setError(null);
              }}
            />
            {/* Inline and above the color list: the panel scrolls, and an
                error parked below every role would go unseen. */}
            {error ? (
              <p aria-live="polite" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <ThemeEditorAppearanceField
              activeAppearance={activeAppearance}
              lockReason={appearanceLockReason}
              onSelect={setActiveAppearance}
            />
            <div className="space-y-3">
              <ThemeEditorColorsHeader
                isAdvanced={isAdvanced}
                onAdvancedChange={handleAdvancedChange}
                onRoleQueryChange={setRoleQuery}
                roleQuery={roleQuery}
              />
              <ThemeEditorColorFields
                colors={colorsByAppearance[activeAppearance]}
                isAdvanced={isAdvanced}
                onChange={updateColor}
                onSelect={selectThemeRole}
                onToggleSelected={toggleThemeRole}
                roleQuery={roleQuery}
                selectedRole={selectedRole}
              />
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border/70 px-3 py-2">
            <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={!name.trim()} size="sm" onClick={handleSubmit}>
              {isEditing ? (
                mergeTarget ? (
                  `Merge into “${mergeTarget.label}”`
                ) : (
                  "Save changes"
                )
              ) : mergeTarget ? (
                <>
                  <PlusIcon />
                  {`Add ${activeAppearance} palette`}
                </>
              ) : (
                <>
                  <PaintbrushIcon />
                  Create theme
                </>
              )}
            </Button>
          </div>
          <div
            aria-hidden
            className="absolute bottom-0 right-0 z-10 flex size-5 cursor-se-resize touch-none select-none items-end justify-end p-1 text-muted-foreground/70"
            {...resizeHandlers}
          >
            <svg
              className="size-2.5"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1.2"
              viewBox="0 0 8 8"
            >
              <path d="M7 1 1 7M7 4.5 4.5 7" />
            </svg>
          </div>
        </>
      )}
    </div>
  );
}
