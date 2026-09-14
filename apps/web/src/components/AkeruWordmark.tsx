import type { ComponentProps } from "react";

import { cn } from "../lib/utils";

/** The product wordmark used in the primary roster and every secondary surface. */
export function AkeruWordmark({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "truncate text-xl leading-none tracking-tight [font-family:var(--font-brand-serif)]",
        className,
      )}
      {...props}
    >
      akeru
    </span>
  );
}
