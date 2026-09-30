import type { ReactNode } from "react";

import { APP_DISPLAY_NAME } from "../../branding";
import { cn } from "~/lib/utils";

/**
 * Full-screen frame for standalone auth pages such as pairing. Renders the
 * app name above a single neutral card and an optional note below it.
 */
export function AuthSurfaceShell({
  children,
  footer,
}: {
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-10 text-foreground sm:px-6">
      <main className="w-full max-w-[420px]">
        <p className="mb-4 px-1 text-sm font-medium text-muted-foreground">{APP_DISPLAY_NAME}</p>
        <section className="overflow-hidden rounded-2xl border bg-card text-card-foreground">
          {children}
        </section>
        {footer ? (
          <div className="mt-4 px-1 text-xs leading-relaxed text-muted-foreground">{footer}</div>
        ) : null}
      </main>
    </div>
  );
}

/** One horizontal band of the auth card. Bands after the first get a divider. */
export function AuthSurfaceSection({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={cn("border-t px-5 py-4 first:border-t-0 sm:px-6", className)}>{children}</div>
  );
}
