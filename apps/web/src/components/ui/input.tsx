"use client";

import { Predicate } from "effect";

import { Input as InputPrimitive } from "@base-ui/react/input";
import type * as React from "react";

import { cn } from "~/lib/utils";

type InputProps = Omit<InputPrimitive.Props & React.RefAttributes<HTMLInputElement>, "size"> & {
  size?: "sm" | "compact" | "default" | "lg" | number;
  reserveWarningSpace?: boolean;
  unstyled?: boolean;
  nativeInput?: boolean;
  /** "color-value" is the compact mono field beside a color swatch; pair it with `unstyled`. */
  variant?:
    | "default"
    | "color-value"
    | "keybinding-capture"
    | "keybinding-expression"
    | "keybinding-search"
    | "mono"
    | "viewport-dimension";
  surface?: "background";
};

function Input({
  className,
  size = "default",
  reserveWarningSpace = false,
  unstyled = false,
  nativeInput = false,
  variant = "default",
  surface,
  ...props
}: InputProps) {
  const inputClassName = cn(
    "h-8.5 w-full min-w-0 rounded-[inherit] px-[calc(--spacing(3)-1px)] leading-8.5 outline-none placeholder:text-placeholder sm:h-7.5 sm:leading-7.5 [transition:background-color_5000000s_ease-in-out_0s]",
    size === "compact" && "h-7 px-[calc(--spacing(2.5)-1px)] text-xs leading-7 sm:h-7 sm:leading-7",
    size === "sm" && "h-7.5 px-[calc(--spacing(2.5)-1px)] leading-7.5 sm:h-6.5 sm:leading-6.5",
    size === "lg" && "h-9.5 leading-9.5 sm:h-8.5 sm:leading-8.5",
    props.type === "search" &&
      "[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none [&::-webkit-search-results-button]:appearance-none [&::-webkit-search-results-decoration]:appearance-none",
    props.type === "file" &&
      "text-muted-foreground file:me-3 file:bg-transparent file:font-medium file:text-foreground file:text-sm",
  );

  let inputElement: React.ReactElement;

  if (nativeInput) {
    const { style, onValueChange: _onValueChange, ...nativeInputProps } = props;

    // Base UI accepts a state callback for style; a native input forwards only a plain object.
    const forwardedProps = Predicate.isFunction(style)
      ? nativeInputProps
      : { ...nativeInputProps, style };

    inputElement = (
      <input
        className={inputClassName}
        data-slot="input"
        size={Predicate.isNumber(size) ? size : undefined}
        {...forwardedProps}
      />
    );
  } else {
    inputElement = (
      <InputPrimitive
        className={inputClassName}
        data-slot="input"
        size={Predicate.isNumber(size) ? size : undefined}
        {...props}
      />
    );
  }

  return (
    <span
      className={
        cn(
          !unstyled &&
            "relative inline-flex w-full rounded-lg border border-transparent bg-secondary text-base text-foreground ring-foreground/20 transition-shadow has-focus-visible:has-aria-invalid:ring-destructive/60 has-aria-invalid:ring-2 has-aria-invalid:ring-destructive/40 has-autofill:bg-foreground/4 has-disabled:opacity-64 has-focus-visible:ring-2 sm:text-sm dark:has-autofill:bg-foreground/8",
          !unstyled &&
            size === "compact" &&
            "rounded-md before:rounded-[calc(var(--radius-md)-1px)]",
          variant === "color-value" &&
            "rounded-md border-0 bg-shade/10 font-mono text-xs text-foreground shadow-none focus-within:bg-shade/15 focus-within:ring-0 dark:bg-shade/20 dark:focus-within:bg-shade/25 [&_[data-slot=input]]:text-right",
          variant === "keybinding-capture" && "border-ring/60 font-mono ring-3 ring-ring/15",
          variant === "keybinding-expression" &&
            "rounded-md font-mono text-xs leading-7 sm:leading-7",
          variant === "keybinding-expression" && reserveWarningSpace && "pr-9",
          variant === "keybinding-expression" &&
            props["aria-invalid"] &&
            "border-destructive/70 focus-visible:border-destructive",
          variant === "keybinding-search" && "[&_[data-slot=input]]:pl-8",
          variant === "mono" && "font-mono",
          variant === "viewport-dimension" &&
            "h-6 rounded-md text-center tabular-nums [&_[data-slot=input]]:h-full [&_[data-slot=input]]:px-1 [&_[data-slot=input]]:text-xs [&_[data-slot=input]]:leading-none [&_[data-slot=input]::-webkit-inner-spin-button]:appearance-none [&_[data-slot=input]]:appearance-textfield",
          surface === "background" && "bg-background",
          className,
        ) || undefined
      }
      data-size={size}
      data-slot="input-control"
    >
      {inputElement}
    </span>
  );
}

export { Input, type InputProps };
