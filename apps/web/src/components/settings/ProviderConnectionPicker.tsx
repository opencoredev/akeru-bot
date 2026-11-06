import { Radio as RadioPrimitive } from "@base-ui/react/radio";

import { useI18n } from "../../i18n";
import { RadioGroup } from "../ui/radio-group";
import type { DriverOption } from "./providerDriverMeta";

/** Chooses how a new account connects when a provider page offers more than one way. */
export function ProviderConnectionPicker(props: {
  readonly options: ReadonlyArray<DriverOption>;
  readonly value: DriverOption["value"];
  readonly onChange: (option: DriverOption) => void;
}) {
  const { t } = useI18n();

  // How each driver on a shared provider page connects, in the user's words.
  const copyByDriver = new Map([
    [
      "claudeAgent",
      { label: t("API key"), tagline: t("An Anthropic API key you add from its card") },
    ],
    [
      "claudeCode",
      { label: t("Claude Agent"), tagline: t("Claude Code on this machine, with its own login") },
    ],
  ]);

  return (
    <div className="grid gap-2">
      <div id="provider-connection-label" className="text-sm font-medium text-foreground">
        {t("How should this account connect?")}
      </div>
      <RadioGroup
        value={props.value}
        onValueChange={(value) => {
          const option = props.options.find((entry) => entry.value === value);

          if (option) props.onChange(option);
        }}
        aria-labelledby="provider-connection-label"
        className="grid grid-cols-1 gap-2 sm:grid-cols-2"
      >
        {props.options.map((option) => {
          const Logo = option.icon;
          const copy = copyByDriver.get(option.value);

          return (
            <RadioPrimitive.Root
              key={option.value}
              value={option.value}
              className="flex cursor-pointer items-center gap-3 rounded-lg bg-card px-3 py-2.5 text-left outline-none ring-1 ring-tint/5 hover:bg-option-hover focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-primary/8 data-checked:ring-2 data-checked:ring-primary data-checked:hover:bg-primary/8 dark:bg-tint/3 dark:hover:bg-tint/5 dark:data-checked:bg-primary/15 dark:data-checked:hover:bg-primary/15"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-background ring-1 ring-tint/8">
                <Logo className="size-4.5" aria-hidden />
              </span>
              <span className="grid min-w-0">
                <span className="truncate text-sm font-medium text-foreground">
                  {copy?.label ?? option.label}
                </span>
                {copy ? (
                  <span className="text-xs text-muted-foreground">{copy.tagline}</span>
                ) : null}
              </span>
            </RadioPrimitive.Root>
          );
        })}
      </RadioGroup>
    </div>
  );
}
