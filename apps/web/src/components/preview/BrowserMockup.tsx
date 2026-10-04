import { cn } from "~/lib/utils";

/** Browser-window thumbnail glyph for preview recommendation cards. */
export function BrowserMockup({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "relative flex flex-col gap-0.5 overflow-hidden rounded-5px border border-border/60 bg-card p-1 shadow-xs/5",
        className,
      )}
    >
      <div className="flex gap-0.5">
        <span className="size-0.75 rounded-full bg-destructive/80" />
        <span className="size-0.75 rounded-full bg-warning/80" />
        <span className="size-0.75 rounded-full bg-success/80" />
      </div>
      <div className="mt-0.25 flex flex-1 flex-col gap-0.5">
        <span className="h-0.5 w-full rounded-full bg-muted-foreground/30" />
        <span className="h-0.5 w-3/5 rounded-full bg-muted-foreground/20" />
      </div>
    </div>
  );
}
