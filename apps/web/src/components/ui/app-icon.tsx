import { HugeiconsIcon, type HugeiconsIconProps } from "@hugeicons/react";
import { cn } from "~/lib/utils";

export function AppIcon({
  strokeWidth = 1.8,
  tone,
  className,
  ...props
}: HugeiconsIconProps & { tone?: "muted" | "sidebar" | "sidebar-muted" | undefined }) {
  return (
    <HugeiconsIcon
      aria-hidden="true"
      strokeWidth={strokeWidth}
      className={
        tone
          ? cn(
              tone === "muted" && "text-muted-foreground",
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
