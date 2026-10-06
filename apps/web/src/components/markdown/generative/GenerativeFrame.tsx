import type { ReactNode } from "react";
import { Card } from "../../ui/card";
import { Skeleton } from "../../ui/skeleton";

/** Shared card chrome for every generative block: optional header, then the body. */
export function GenerativeFrame({
  kind,
  title,
  subtitle,
  aside,
  children,
}: {
  readonly kind: string;
  readonly title?: string | undefined;
  readonly subtitle?: string | undefined;
  readonly aside?: ReactNode;
  readonly children: ReactNode;
}) {
  const hasHeader = title !== undefined || subtitle !== undefined || aside !== undefined;

  return (
    <div className="chat-generative" data-generative={kind}>
      <Card>
        {hasHeader ? (
          // On a narrow card the aside (a chart legend) wraps below the title instead of truncating it.
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5 px-4 pt-3.5">
            <div className="min-w-0 flex-1 basis-40">
              {title ? (
                <div className="truncate text-sm font-semibold text-foreground">{title}</div>
              ) : null}
              {subtitle ? (
                <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
              ) : null}
            </div>
            {aside ? <div className="shrink-0">{aside}</div> : null}
          </div>
        ) : null}
        <div className="px-4 pt-3 pb-3.5">{children}</div>
      </Card>
    </div>
  );
}

/** Placeholder while a block's JSON is still streaming in. */
export function GenerativeBlockPending() {
  return (
    <div className="chat-generative" data-generative="pending">
      <Card>
        <div className="flex flex-col gap-2.5 px-4 py-3.5">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-24 w-full" />
        </div>
      </Card>
    </div>
  );
}
