"use client";

import { Predicate } from "effect";

import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { ChevronsUpDownIcon, XIcon } from "lucide-react";
import * as React from "react";

import { cn } from "~/lib/utils";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";

const ComboboxContext = React.createContext<{
  chipsRef: React.RefObject<HTMLDivElement | null> | null;
  multiple: boolean;
}>({
  chipsRef: null,
  multiple: false,
});

function Combobox<Value, Multiple extends boolean | undefined = false>(
  props: ComboboxPrimitive.Root.Props<Value, Multiple>,
) {
  const chipsRef = React.useRef<HTMLDivElement | null>(null);
  const value = React.useMemo(() => ({ chipsRef, multiple: !!props.multiple }), [props.multiple]);

  return (
    <ComboboxContext value={value}>
      <ComboboxPrimitive.Root {...props} />
    </ComboboxContext>
  );
}

function ComboboxChipsInput({
  className,
  size,
  ...props
}: Omit<ComboboxPrimitive.Input.Props, "size"> & {
  size?: "sm" | "default" | "lg" | number;
  ref?: React.Ref<HTMLInputElement>;
}) {
  const sizeValue = size ?? "default";

  return (
    <ComboboxPrimitive.Input
      className={cn(
        "min-w-12 flex-1 text-base outline-none sm:text-sm [[data-slot=combobox-chip]+&]:ps-0.5",
        sizeValue === "sm" ? "ps-1.5" : "ps-2",
        className,
      )}
      data-size={Predicate.isString(sizeValue) ? sizeValue : undefined}
      data-slot="combobox-chips-input"
      size={Predicate.isNumber(sizeValue) ? sizeValue : undefined}
      {...props}
    />
  );
}

function ComboboxInput({
  className,
  inputClassName,
  presentation,
  showTrigger = true,
  showClear = false,
  startAddon,
  size,
  unstyled = false,
  ...props
}: Omit<ComboboxPrimitive.Input.Props, "size"> & {
  inputClassName?: string;
  presentation?: "font-search" | "model-search";
  showTrigger?: boolean;
  showClear?: boolean;
  startAddon?: React.ReactNode;
  size?: "sm" | "default" | "lg" | number;
  unstyled?: boolean;
  ref?: React.Ref<HTMLInputElement>;
}) {
  const sizeValue = size ?? "default";

  return (
    <div className="relative not-has-[>*.w-full]:w-fit w-full text-foreground has-disabled:opacity-64">
      {startAddon && (
        <div
          aria-hidden="true"
          className="[&_svg]:-mx-0.5 pointer-events-none absolute inset-y-0 start-px z-10 flex items-center ps-[calc(--spacing(3)-1px)] opacity-80 has-[+[data-size=sm]]:ps-[calc(--spacing(2.5)-1px)] [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4"
          data-slot="combobox-start-addon"
        >
          {startAddon}
        </div>
      )}
      <ComboboxPrimitive.Input
        className={cn(
          startAddon &&
            "data-[size=sm]:*:data-[slot=combobox-input]:ps-[calc(--spacing(7.5)-1px)] *:data-[slot=combobox-input]:ps-[calc(--spacing(8.5)-1px)] sm:data-[size=sm]:*:data-[slot=combobox-input]:ps-[calc(--spacing(7)-1px)] sm:*:data-[slot=combobox-input]:ps-[calc(--spacing(8)-1px)]",
          sizeValue === "sm"
            ? "has-[+[data-slot=combobox-trigger],+[data-slot=combobox-clear]]:*:data-[slot=combobox-input]:pe-6.5"
            : "has-[+[data-slot=combobox-trigger],+[data-slot=combobox-clear]]:*:data-[slot=combobox-input]:pe-7",
          presentation === "font-search" &&
            "[&_input]:h-6.5 [&_input]:ps-5 [&_input]:font-sans [&_input]:leading-6.5",
          presentation === "model-search" &&
            "[&_input]:h-6.5 [&_input]:font-sans [&_input]:leading-6.5",
          className,
        )}
        data-slot="combobox-input"
        render={
          <Input
            className={cn(
              "has-disabled:opacity-100",
              (presentation === "font-search" || presentation === "model-search") &&
                "rounded-none bg-transparent text-sm",
              inputClassName,
            )}
            nativeInput
            size={sizeValue}
            unstyled={unstyled}
          />
        }
        {...props}
      />
      {showTrigger && (
        <ComboboxTrigger
          className={cn(
            "-translate-y-1/2 absolute top-1/2 inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-transparent opacity-80 outline-none transition-opacity pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:opacity-100 has-[+[data-slot=combobox-clear]]:hidden sm:size-7 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
            sizeValue === "sm" ? "end-0" : "end-0.5",
          )}
        >
          <ComboboxPrimitive.Icon data-slot="combobox-icon">
            <ChevronsUpDownIcon />
          </ComboboxPrimitive.Icon>
        </ComboboxTrigger>
      )}
      {showClear && (
        <ComboboxClear
          className={cn(
            "-translate-y-1/2 absolute top-1/2 inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-transparent opacity-80 outline-none transition-opacity pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:opacity-100 has-[+[data-slot=combobox-clear]]:hidden sm:size-7 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
            sizeValue === "sm" ? "end-0" : "end-0.5",
          )}
        >
          <XIcon />
        </ComboboxClear>
      )}
    </div>
  );
}

function ComboboxTrigger({
  className,
  children,
  presentation,
  ...props
}: ComboboxPrimitive.Trigger.Props & { presentation?: "font-family" }) {
  return (
    <ComboboxPrimitive.Trigger
      className={cn(
        presentation === "font-family" &&
          "relative inline-flex min-h-9 w-full min-w-36 cursor-pointer select-none items-center justify-between gap-2 rounded-lg border border-transparent bg-secondary px-[calc(--spacing(3)-1px)] text-left text-base text-foreground outline-none transition-[color,box-shadow] focus-visible:ring-2 focus-visible:ring-ring/70 sm:min-h-8 sm:text-sm",
        className,
      )}
      data-slot="combobox-trigger"
      {...props}
    >
      {children}
    </ComboboxPrimitive.Trigger>
  );
}

function ComboboxPopup({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  alignOffset,
  align = "start",
  anchor: anchorProp,
  ...props
}: ComboboxPrimitive.Popup.Props & {
  align?: ComboboxPrimitive.Positioner.Props["align"];
  sideOffset?: ComboboxPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: ComboboxPrimitive.Positioner.Props["alignOffset"];
  side?: ComboboxPrimitive.Positioner.Props["side"];
  anchor?: ComboboxPrimitive.Positioner.Props["anchor"];
}) {
  const { chipsRef } = React.use(ComboboxContext);
  const anchor = anchorProp ?? chipsRef;

  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        className="z-[130] select-none"
        data-slot="combobox-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <span
          className={cn(
            "dropdown-glass relative flex max-h-full min-w-(--anchor-width) max-w-(--available-width) origin-(--transform-origin) rounded-lg shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] transition-[scale,opacity] dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]",
            className,
          )}
        >
          <ComboboxPrimitive.Popup
            className="flex max-h-[min(var(--available-height),23rem)] flex-1 flex-col text-foreground"
            data-slot="combobox-popup"
            {...props}
          >
            {children}
          </ComboboxPrimitive.Popup>
        </span>
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

const MODEL_OPTION_ITEM_CLASSES =
  "rounded-md px-2 py-2 transition-bg-color-shadow hover:bg-popover-highlight data-highlighted:bg-popover-highlight data-selected:bg-foreground/[0.08] data-selected:text-foreground data-selected:ring-0 [&[data-highlighted][data-selected]]:bg-popover-highlight";

// Roomier picker rows. `model-option` adds the picker's own highlight fill.
const COMBOBOX_ITEM_VARIANTS = {
  default: { item: undefined, content: undefined },
  "model-row": { item: "rounded-md px-2 py-2", content: "gap-3" },
  "model-option": { item: MODEL_OPTION_ITEM_CLASSES, content: "gap-3" },
  "model-option-disabled": {
    item: `${MODEL_OPTION_ITEM_CLASSES} data-disabled:hover:bg-transparent`,
    content: "gap-3",
  },
} as const;

function ComboboxItem({
  className,
  contentClassName,
  children,
  hideIndicator: _hideIndicator = false,
  variant = "default",
  ...props
}: ComboboxPrimitive.Item.Props & {
  contentClassName?: string;
  hideIndicator?: boolean;
  variant?: keyof typeof COMBOBOX_ITEM_VARIANTS;
}) {
  return (
    <ComboboxPrimitive.Item
      className={cn(
        "flex min-h-8 in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] cursor-pointer items-center rounded-sm px-2 py-1 text-base outline-none hover:bg-accent data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-selected:bg-foreground/[0.08] data-selected:text-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground [&[data-highlighted][data-selected]]:bg-accent [&[data-highlighted][data-selected]]:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        COMBOBOX_ITEM_VARIANTS[variant].item,
        className,
      )}
      data-slot="combobox-item"
      {...props}
    >
      <div
        className={cn(
          "min-w-0 flex-1 [&_svg:not([class*='text-'])]:text-muted-foreground",
          COMBOBOX_ITEM_VARIANTS[variant].content,
          contentClassName,
        )}
        data-slot="combobox-item-content"
      >
        {children}
      </div>
    </ComboboxPrimitive.Item>
  );
}

function ComboboxSeparator({ className, ...props }: ComboboxPrimitive.Separator.Props) {
  return (
    <ComboboxPrimitive.Separator
      className={cn("mx-2 my-1 h-px bg-border last:hidden", className)}
      data-slot="combobox-separator"
      {...props}
    />
  );
}

function ComboboxGroup({ className, ...props }: ComboboxPrimitive.Group.Props) {
  return (
    <ComboboxPrimitive.Group
      className={cn("[[role=group]+&]:mt-1.5", className)}
      data-slot="combobox-group"
      {...props}
    />
  );
}

function ComboboxGroupLabel({ className, ...props }: ComboboxPrimitive.GroupLabel.Props) {
  return (
    <ComboboxPrimitive.GroupLabel
      className={cn("px-2 py-1.5 font-medium text-muted-foreground text-xs", className)}
      data-slot="combobox-group-label"
      {...props}
    />
  );
}

function ComboboxEmpty({ className, ...props }: ComboboxPrimitive.Empty.Props) {
  return (
    <ComboboxPrimitive.Empty
      className={cn(
        "not-empty:p-2 text-center text-base text-muted-foreground sm:text-sm",
        className,
      )}
      data-slot="combobox-empty"
      {...props}
    />
  );
}

function ComboboxRow({ className, ...props }: ComboboxPrimitive.Row.Props) {
  return <ComboboxPrimitive.Row className={className} data-slot="combobox-row" {...props} />;
}

function ComboboxValue({ ...props }: ComboboxPrimitive.Value.Props) {
  return <ComboboxPrimitive.Value data-slot="combobox-value" {...props} />;
}

function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ScrollArea scrollbarGutter scrollFade>
      <ComboboxPrimitive.List
        className={cn("not-empty:scroll-py-1 not-empty:px-1 not-empty:py-1", className)}
        data-slot="combobox-list"
        {...props}
      />
    </ScrollArea>
  );
}

/**
 * A variant of `ComboboxList` without `ScrollArea`, for use when
 * an external virtualizer (e.g. LegendList) owns the scroll container.
 */
function ComboboxListVirtualized({
  className,
  presentation,
  ...props
}: ComboboxPrimitive.List.Props & { presentation?: "font-family" | "model-list" }) {
  return (
    <ComboboxPrimitive.List
      className={cn(
        "not-empty:px-1 not-empty:py-1",
        presentation === "font-family" && "size-full min-w-0 p-0",
        presentation === "model-list" && "size-full min-w-0 p-0 not-empty:p-0",
        className,
      )}
      data-slot="combobox-list"
      {...props}
    />
  );
}

function ComboboxClear({ className, ...props }: ComboboxPrimitive.Clear.Props) {
  return <ComboboxPrimitive.Clear className={className} data-slot="combobox-clear" {...props} />;
}

function ComboboxStatus({ className, ...props }: ComboboxPrimitive.Status.Props) {
  return (
    <ComboboxPrimitive.Status
      className={cn(
        "px-3 py-2 font-medium text-muted-foreground text-xs empty:m-0 empty:p-0",
        className,
      )}
      data-slot="combobox-status"
      {...props}
    />
  );
}

function ComboboxCollection(props: ComboboxPrimitive.Collection.Props) {
  return <ComboboxPrimitive.Collection data-slot="combobox-collection" {...props} />;
}

function ComboboxChips({
  className,
  children,
  startAddon,
  ...props
}: ComboboxPrimitive.Chips.Props & {
  startAddon?: React.ReactNode;
}) {
  const { chipsRef } = React.use(ComboboxContext);

  return (
    <ComboboxPrimitive.Chips
      className={cn(
        "relative inline-flex min-h-9 w-full flex-wrap gap-1 rounded-lg border border-transparent bg-secondary p-[calc(--spacing(1)-1px)] text-base outline-none ring-foreground/20 transition-shadow *:min-h-7 focus-within:ring-2 has-disabled:pointer-events-none has-data-[size=lg]:min-h-10 has-data-[size=sm]:min-h-8 has-aria-invalid:ring-2 has-aria-invalid:ring-destructive/40 has-autofill:bg-foreground/4 has-disabled:opacity-64 focus-within:has-aria-invalid:ring-destructive/60 has-data-[size=lg]:*:min-h-8 has-data-[size=sm]:*:min-h-6 sm:min-h-8 sm:text-sm sm:has-data-[size=lg]:min-h-9 sm:has-data-[size=sm]:min-h-7 sm:*:min-h-6 sm:has-data-[size=lg]:*:min-h-7 sm:has-data-[size=sm]:*:min-h-5 dark:has-autofill:bg-foreground/8",
        className,
      )}
      data-slot="combobox-chips"
      ref={chipsRef}
      {...props}
    >
      {startAddon && (
        <div
          aria-hidden="true"
          className="[&_svg]:-ms-0.5 [&_svg]:-me-1.5 flex shrink-0 items-center ps-2 opacity-80 has-[~[data-size=sm]]:has-[+[data-slot=combobox-chip]]:pe-1.5 has-[~[data-size=sm]]:ps-1.5 has-[+[data-slot=combobox-chip]]:pe-2 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none"
          data-slot="combobox-start-addon"
        >
          {startAddon}
        </div>
      )}
      {children}
    </ComboboxPrimitive.Chips>
  );
}

function ComboboxChip({ children, ...props }: ComboboxPrimitive.Chip.Props) {
  return (
    <ComboboxPrimitive.Chip
      className="flex items-center rounded-[calc(var(--radius-md)-1px)] bg-accent ps-2 font-medium text-accent-foreground text-sm outline-none sm:text-xs/(--text-xs--line-height) [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5"
      data-slot="combobox-chip"
      {...props}
    >
      {children}
      <ComboboxChipRemove />
    </ComboboxPrimitive.Chip>
  );
}

function ComboboxChipRemove(props: ComboboxPrimitive.ChipRemove.Props) {
  return (
    <ComboboxPrimitive.ChipRemove
      aria-label="Remove"
      className="h-full shrink-0 cursor-pointer px-1.5 opacity-80 hover:opacity-100 [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5"
      data-slot="combobox-chip-remove"
      {...props}
    >
      <XIcon />
    </ComboboxPrimitive.ChipRemove>
  );
}

const useComboboxFilter = ComboboxPrimitive.useFilter;

export {
  Combobox,
  ComboboxChipsInput,
  ComboboxInput,
  ComboboxTrigger,
  ComboboxPopup,
  ComboboxItem,
  ComboboxSeparator,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxEmpty,
  ComboboxValue,
  ComboboxList,
  ComboboxListVirtualized,
  ComboboxClear,
  ComboboxStatus,
  ComboboxRow,
  ComboboxCollection,
  ComboboxChips,
  ComboboxChip,
  useComboboxFilter,
};
