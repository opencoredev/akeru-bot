import type { ThemeAppearance, ThemeColorRole, ThemeColors } from "../../themePalette";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThemeColorField } from "./ThemeColorPicker";
import {
  filterThemeEditorRoleGroups,
  THEME_EDITOR_SIMPLE_ROLES,
  type ThemeEditorColorFamily,
} from "./themeEditorRoles";

export function ThemeEditorNameField({
  isEditing,
  name,
  onNameChange,
}: {
  isEditing: boolean;
  name: string;
  onNameChange: (name: string) => void;
}) {
  return (
    <label className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-center gap-3">
      <span className="text-sm font-medium">Theme name</span>
      <Input
        autoFocus
        onChange={(event) => onNameChange(event.currentTarget.value)}
        placeholder={isEditing ? "Theme name" : "e.g. Aurora"}
        value={name}
      />
    </label>
  );
}

function ThemeEditorAppearanceButton({
  appearance,
  isActive,
  lockReason,
  onSelect,
}: {
  appearance: ThemeAppearance;
  isActive: boolean;
  lockReason: string | null;
  onSelect: (appearance: ThemeAppearance) => void;
}) {
  // A locked mode stays hoverable so the tooltip can say why it is off;
  // a real disabled attribute would swallow the pointer events.
  const button = (
    <Button
      aria-disabled={lockReason !== null}
      aria-pressed={isActive}
      variant={isActive ? "segment-selected" : "segment"}
      onClick={() => {
        if (lockReason === null) onSelect(appearance);
      }}
    >
      {appearance === "light" ? "Light" : "Dark"}
    </Button>
  );
  if (lockReason === null) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup>{lockReason}</TooltipPopup>
    </Tooltip>
  );
}

export function ThemeEditorAppearanceField({
  activeAppearance,
  lockReason,
  onSelect,
}: {
  activeAppearance: ThemeAppearance;
  lockReason: (appearance: ThemeAppearance) => string | null;
  onSelect: (appearance: ThemeAppearance) => void;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-center gap-3">
      <span className="text-sm font-medium">Appearance</span>
      <div aria-label="Theme appearance" className="grid grid-cols-2 gap-2" role="group">
        {(["light", "dark"] as const).map((appearance) => (
          <ThemeEditorAppearanceButton
            appearance={appearance}
            isActive={activeAppearance === appearance}
            key={appearance}
            lockReason={lockReason(appearance)}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}

export function ThemeEditorColorsHeader({
  isAdvanced,
  roleQuery,
  onRoleQueryChange,
  onAdvancedChange,
}: {
  isAdvanced: boolean;
  roleQuery: string;
  onRoleQueryChange: (query: string) => void;
  onAdvancedChange: (advanced: boolean) => void;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-start gap-3">
      <div>
        <h3 className="text-sm font-medium">Colors</h3>
        {isAdvanced ? null : (
          <p className="text-xs text-muted-foreground">Two colors, rest derived</p>
        )}
      </div>
      <div className="flex min-w-0 items-start gap-3">
        {isAdvanced ? (
          <Input
            aria-label="Filter colors"
            className="min-w-0 flex-1"
            onChange={(event) => onRoleQueryChange(event.currentTarget.value)}
            placeholder="Filter colors"
            size="sm"
            value={roleQuery}
          />
        ) : null}
        <label className="ml-auto flex shrink-0 cursor-pointer items-center gap-2 pt-0.5 text-sm font-medium">
          <span>Advanced</span>
          <Switch
            aria-label="Use advanced theme colors"
            checked={isAdvanced}
            onCheckedChange={(checked) => onAdvancedChange(Boolean(checked))}
          />
        </label>
      </div>
    </div>
  );
}

type ThemeEditorColorFieldHandlers = {
  colors: ThemeColors;
  selectedRole: ThemeColorRole | null;
  onChange: (role: ThemeColorRole, value: string) => void;
  onSelect: (role: ThemeColorRole) => void;
  onToggleSelected: (role: ThemeColorRole) => void;
};

function ThemeEditorFamilyFields({
  families,
  colors,
  selectedRole,
  onChange,
  onSelect,
  onToggleSelected,
}: ThemeEditorColorFieldHandlers & { families: ReadonlyArray<ThemeEditorColorFamily> }) {
  return (
    <div className="grid gap-1">
      {families.map((family) => (
        <ThemeColorField
          key={family.id}
          label={family.label}
          onChange={onChange}
          onSelect={onSelect}
          onToggleSelected={onToggleSelected}
          role={family.role}
          selected={selectedRole === family.role}
          value={colors[family.role]}
        />
      ))}
    </div>
  );
}

/** Guided mode shows the two source colors; advanced mode shows every family, filtered. */
export function ThemeEditorColorFields({
  isAdvanced,
  roleQuery,
  ...handlers
}: ThemeEditorColorFieldHandlers & { isAdvanced: boolean; roleQuery: string }) {
  if (!isAdvanced) {
    return (
      <div className="grid gap-1">
        {THEME_EDITOR_SIMPLE_ROLES.map((role) => (
          <ThemeColorField
            key={role}
            onChange={handlers.onChange}
            onSelect={handlers.onSelect}
            onToggleSelected={handlers.onToggleSelected}
            role={role}
            label={role === "canvas" ? "Background" : "Accent"}
            selected={handlers.selectedRole === role}
            value={handlers.colors[role]}
          />
        ))}
      </div>
    );
  }

  const groups = filterThemeEditorRoleGroups(roleQuery);
  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <section className="space-y-2" key={group.id}>
          <h4 className="text-sm font-medium text-foreground">{group.title}</h4>
          <ThemeEditorFamilyFields families={group.families} {...handlers} />
        </section>
      ))}
      {groups.length === 0 ? <p className="text-xs text-muted-foreground">No matches.</p> : null}
    </div>
  );
}
