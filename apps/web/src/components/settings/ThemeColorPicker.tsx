import { memo } from "react";
import { isThemeColor, themeColorToHex, type ThemeColorRole } from "../../themePalette";
import { cn } from "../../lib/utils";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { getThemeRoleLabel } from "./themeColorPicker.logic";
import { ThemeColorPickerPanel } from "./ThemeColorPickerPanel";

function ThemeColorPicker({
  label,
  value,
  onChange,
  onInteract,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onInteract?: () => void;
}) {
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <button
                  aria-label={`Choose ${label} color`}
                  className="relative flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full border border-foreground/30 transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  onFocus={onInteract}
                  onPointerDown={onInteract}
                  type="button"
                >
                  <span
                    className="absolute inset-0 rounded-full shadow-sm"
                    // oxlint-disable-next-line shadcn/no-inline-styles -- swatch shows the color being edited
                    style={{ backgroundColor: value }}
                  />
                </button>
              }
            />
          }
        />
        <TooltipPopup side="top">{`Choose ${label} color`}</TooltipPopup>
      </Tooltip>
      <PopoverPopup
        align="end"
        className="overflow-hidden"
        data-theme-editor-panel=""
        side="bottom"
        sideOffset={10}
        variant="color-picker"
      >
        <ThemeColorPickerPanel label={label} onChange={onChange} value={value} />
      </PopoverPopup>
    </Popover>
  );
}

export const ThemeColorField = memo(function ThemeColorField({
  role,
  value,
  onChange,
  onSelect,
  onToggleSelected,
  selected = false,
  label: customLabel,
}: {
  role: ThemeColorRole;
  value: string;
  onChange: (role: ThemeColorRole, value: string) => void;
  onSelect?: (role: ThemeColorRole) => void;
  onToggleSelected?: (role: ThemeColorRole) => void;
  selected?: boolean;
  label?: string;
}) {
  const label = customLabel ?? getThemeRoleLabel(role);
  const isColorValue = isThemeColor(value);
  const swatchValue = isColorValue ? value : "#000000";
  const editorValue = value.trim().toLowerCase().startsWith("oklch(")
    ? (themeColorToHex(value) ?? value)
    : value;

  return (
    <div
      className={cn(
        "flex min-h-11 min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 transition",
        selected && "bg-accent/60 inset-ring inset-ring-ring",
      )}
      data-theme-color-role={role}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              aria-label={`${selected ? "Hide" : "Show"} ${label} usage`}
              aria-pressed={selected}
              className="flex min-w-0 flex-1 cursor-pointer items-center rounded-md text-left text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onToggleSelected?.(role)}
              type="button"
            >
              <span className="min-w-0 flex-1 truncate">{label}</span>
            </button>
          }
        />
        <TooltipPopup side="top">{`${selected ? "Hide" : "Show"} where ${label} is used`}</TooltipPopup>
      </Tooltip>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <ThemeColorPicker
          label={label}
          onChange={(nextValue) => onChange(role, nextValue)}
          onInteract={() => onSelect?.(role)}
          value={swatchValue}
        />
        <Input
          aria-invalid={!isColorValue}
          aria-label={`${label} hex value`}
          className="w-28 shrink-0"
          id={`${role}-hex`}
          nativeInput
          onChange={(event) => onChange(role, event.currentTarget.value)}
          onFocus={() => onSelect?.(role)}
          onPointerDown={() => onSelect?.(role)}
          size="sm"
          unstyled
          value={editorValue}
          variant="color-value"
        />
      </div>
    </div>
  );
});
