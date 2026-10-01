import { cn } from "~/lib/utils";

function Skeleton({
  className,
  tone = "default",
  ...props
}: React.ComponentProps<"div"> & {
  /** `faint` is a lighter block for large chart areas. */
  tone?: "default" | "faint";
}) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-sm bg-muted [--skeleton-highlight:--alpha(var(--color-white)/64%)] after:absolute after:inset-0 after:animate-skeleton after:bg-[linear-gradient(120deg,transparent_40%,var(--skeleton-highlight),transparent_60%)] motion-reduce:after:content-none dark:[--skeleton-highlight:--alpha(var(--color-white)/4%)]",
        tone === "faint" && "bg-muted-foreground/10",
        className,
      )}
      data-slot="skeleton"
      {...props}
    />
  );
}

export { Skeleton };
