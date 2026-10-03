import { Radio as RadioPrimitive } from "@base-ui/react/radio";

import { RadioGroup } from "../ui/radio-group";
import { CUSTOM_API_PRESETS, type CustomApiPreset } from "./customApiPresets";

/** Starting points for a Custom API instance. Picking one fills in its base URL. */
export function CustomApiPresetPicker(props: {
  readonly value: CustomApiPreset["id"];
  readonly onChange: (preset: CustomApiPreset) => void;
}) {
  return (
    <div className="grid gap-2">
      <div id="custom-api-preset-label" className="text-sm font-medium text-foreground">
        What are you connecting to?
      </div>
      <RadioGroup
        value={props.value}
        onValueChange={(value) => {
          const preset = CUSTOM_API_PRESETS.find((entry) => entry.id === value);

          if (preset) props.onChange(preset);
        }}
        aria-labelledby="custom-api-preset-label"
        className="grid grid-cols-1 gap-2 sm:grid-cols-2"
      >
        {CUSTOM_API_PRESETS.map((preset) => {
          const Logo = preset.icon;

          return (
            <RadioPrimitive.Root
              key={preset.id}
              value={preset.id}
              className="flex cursor-pointer items-center gap-3 rounded-lg bg-card px-3 py-2.5 text-left outline-none ring-1 ring-tint/5 hover:bg-option-hover focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-primary/8 data-checked:ring-2 data-checked:ring-primary data-checked:hover:bg-primary/8 dark:bg-tint/3 dark:hover:bg-tint/5 dark:data-checked:bg-primary/15 dark:data-checked:hover:bg-primary/15"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-background ring-1 ring-tint/8">
                <Logo className="size-4.5" aria-hidden />
              </span>
              <span className="grid min-w-0">
                <span className="truncate text-sm font-medium text-foreground">{preset.label}</span>
                <span className="truncate text-xs text-muted-foreground">{preset.tagline}</span>
              </span>
            </RadioPrimitive.Root>
          );
        })}
      </RadioGroup>
    </div>
  );
}
