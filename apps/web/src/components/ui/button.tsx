"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "~/lib/utils";

const buttonVariants = cva(
  "[--control-icon-color:currentColor] [&_svg]:-mx-0.5 relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[var(--control-radius)] border font-medium text-base outline-none transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--control-radius)-1px)] pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 sm:text-sm [&_svg:not([class*='text-'])]:text-[var(--control-icon-color)] [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        compact:
          "h-7 gap-1 rounded-md px-[calc(--spacing(2)-1px)] text-xs before:rounded-[calc(var(--radius-md)-1px)] [&_svg:not([class*='size-'])]:size-3.5",
        // Wraps an avatar or avatar tile: the child sets the size.
        avatar: "p-0",
        default: "h-9 px-[calc(--spacing(3)-1px)] sm:h-8",
        icon: "size-9 sm:size-8",
        "icon-lg": "size-10 sm:size-9",
        "icon-micro":
          "size-5 rounded-sm p-0 before:rounded-[calc(var(--radius-sm)-1px)] [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8 sm:size-7",
        "icon-sm-round": "size-8 rounded-full sm:size-7",
        "icon-xl":
          "size-11 sm:size-10 [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
        "icon-xs":
          "size-7 sm:size-6 not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-4 sm:not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 px-[calc(--spacing(3.5)-1px)] sm:h-9",
        /** Full-width sheet row whose label lines up with the sheet's other row labels. */
        row: "h-8 gap-1.5 px-2 sm:h-7",
        /** `row` with roomier gaps and regular weight, for list entries with trailing meta. */
        "row-relaxed": "h-8 gap-3 px-2 font-normal sm:h-7",
        micro:
          "h-5 gap-1 rounded-sm px-[calc(--spacing(1.5)-1px)] text-[11px] before:rounded-[calc(var(--radius-sm)-1px)] sm:text-[11px] [&_svg:not([class*='size-'])]:size-3 sm:[&_svg:not([class*='size-'])]:size-3",
        onboarding: "h-10 rounded-xl px-[calc(--spacing(3)-1px)] sm:h-8",
        sm: "h-8 gap-1.5 px-[calc(--spacing(2.5)-1px)] sm:h-7",
        xl: "h-11 px-[calc(--spacing(4)-1px)] text-lg sm:h-10 sm:text-base [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
        xs: "h-7 gap-1 px-[calc(--spacing(2)-1px)] text-sm sm:h-6 sm:text-xs [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5",
      },
      variant: {
        // A bare avatar with an edit badge; its focus ring hugs the rounded avatar.
        "avatar-edit":
          "inline-block rounded-2xl border-0 transition-none focus-visible:ring-offset-0 [&_svg]:mx-0",
        // A square pickable avatar tile; aria-pressed marks the chosen one.
        "avatar-tile":
          "rounded-xl border-transparent transition-colors focus-visible:ring-foreground/20 focus-visible:ring-offset-0 not-aria-pressed:hover:bg-secondary/70 aria-pressed:border-border aria-pressed:bg-secondary [&_svg]:mx-0",
        default:
          "border-transparent bg-foreground text-background [:active,[data-pressed]]:bg-foreground/80 [:hover,[data-pressed]]:bg-foreground/88",
        // Primary action that turns into a quiet muted block while disabled.
        "default-muted-disabled":
          "border-transparent bg-foreground text-background disabled:border-border disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100 [:active,[data-pressed]]:bg-foreground/80 [:hover,[data-pressed]]:bg-foreground/88",
        destructive:
          "border-transparent bg-destructive text-white [:active,[data-pressed]]:bg-destructive/80 [:hover,[data-pressed]]:bg-destructive/90",
        "destructive-outline":
          "border-transparent bg-secondary text-destructive-foreground [:hover,[data-pressed]]:bg-destructive/12",
        ghost:
          "[--control-icon-color:var(--contrast-muted-foreground)] border-transparent text-foreground data-pressed:bg-accent [:hover,[data-pressed]]:bg-accent",
        "ghost-destructive":
          "[--control-icon-color:var(--contrast-muted-foreground)] border-transparent text-destructive data-pressed:bg-accent [:hover,[data-pressed]]:bg-accent",
        "ghost-muted":
          "[--control-icon-color:var(--contrast-muted-foreground)] border-transparent text-muted-foreground data-pressed:bg-accent [:hover,[data-pressed]]:bg-accent [:hover,[data-pressed]]:text-foreground",
        /** Quiet sheet row; the hover fill marks it without changing its color. */
        "ghost-quiet":
          "[--control-icon-color:var(--contrast-muted-foreground)] border-transparent text-muted-foreground data-pressed:bg-accent [:hover,[data-pressed]]:bg-accent",
        /** The selected `ghost-quiet` row. */
        "ghost-current":
          "[--control-icon-color:var(--contrast-muted-foreground)] border-transparent bg-muted text-foreground data-pressed:bg-accent [:hover,[data-pressed]]:bg-accent",
        glass:
          "surface-glass [--control-icon-color:var(--contrast-muted-foreground)] border-transparent text-foreground [:hover,[data-pressed]]:bg-accent/60",
        link: "border-transparent underline-offset-4 [:hover,[data-pressed]]:underline",
        outline:
          "[--control-icon-color:var(--contrast-muted-foreground)] border-transparent bg-secondary text-foreground [:active,[data-pressed]]:bg-accent [:hover,[data-pressed]]:bg-accent/80",
        /** Rounded icon control on sidebar chrome, muted until hovered. */
        "sidebar-ghost":
          "[--control-icon-color:var(--contrast-muted-foreground)] rounded-lg border-transparent text-sidebar-muted-foreground hover:text-sidebar-foreground data-pressed:bg-accent [:hover,[data-pressed]]:bg-accent",
        // A round floating outline control with muted ink, such as jump to latest.
        "outline-pill-muted":
          "[--control-icon-color:var(--contrast-muted-foreground)] rounded-full border-transparent bg-secondary text-muted-foreground shadow-xs hover:text-foreground [:active,[data-pressed]]:bg-accent [:hover,[data-pressed]]:bg-accent/80",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground [:active,[data-pressed]]:bg-secondary/80 [:hover,[data-pressed]]:bg-secondary/90",
        // Segmented choice: an unselected option, dimmed while aria-disabled.
        segment:
          "[--control-icon-color:var(--contrast-muted-foreground)] border-transparent bg-secondary text-foreground [:active,[data-pressed]]:bg-accent [:hover,[data-pressed]]:bg-accent/80 aria-disabled:opacity-50",
        // Segmented choice: the selected option, outlined with the focus ring color.
        "segment-selected":
          "border-transparent bg-secondary text-secondary-foreground inset-ring inset-ring-ring [:active,[data-pressed]]:bg-secondary/80 [:hover,[data-pressed]]:bg-secondary/90 aria-disabled:opacity-50",
        // Muted icon action that fades out while aria-hidden.
        "ghost-fade":
          "[--control-icon-color:var(--contrast-muted-foreground)] border-transparent text-muted-foreground transition-opacity data-pressed:bg-accent [:hover,[data-pressed]]:bg-accent aria-hidden:pointer-events-none aria-hidden:opacity-0",
      },
    },
  },
);

interface ButtonProps extends useRender.ComponentProps<"button"> {
  variant?: VariantProps<typeof buttonVariants>["variant"];
  size?: VariantProps<typeof buttonVariants>["size"];
}

function Button({ className, variant, size, render, ...props }: ButtonProps) {
  const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>["type"] = render
    ? undefined
    : "button";

  const defaultProps = {
    className: cn(buttonVariants({ className, size, variant })),
    "data-slot": "button",
    type: typeValue,
  };

  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}

export { Button, buttonVariants };
