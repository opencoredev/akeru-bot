import { HugeiconsIcon, type HugeiconsIconProps } from "@hugeicons/react";
import { cn } from "~/lib/utils";

export function AppIcon({
  strokeWidth = 1.8,
  tone,
  fit,
  className,
  ...props
}: HugeiconsIconProps & {
  tone?: "muted" | "muted-hover" | "sidebar" | "sidebar-muted" | undefined;
  /** "inline-chip" sizes the icon like the other inline chip icons (COMPOSER_INLINE_CHIP_ICON_CLASS_NAME). */
  fit?: "inline-chip" | undefined;
}) {
  return (
    <HugeiconsIcon
      aria-hidden="true"
      strokeWidth={strokeWidth}
      className={
        tone || fit
          ? cn(
              fit === "inline-chip" &&
                "block size-[1.17em] shrink-0 self-center opacity-85 [&>svg]:block",
              tone === "muted" && "text-muted-foreground",
              tone === "muted-hover" &&
                "text-muted-foreground transition-colors group-hover:text-foreground",
              tone === "sidebar" && "text-sidebar-foreground",
              tone === "sidebar-muted" && "text-sidebar-muted-foreground",
              className,
            )
          : className
      }
      {...props}
    />
  );
}
