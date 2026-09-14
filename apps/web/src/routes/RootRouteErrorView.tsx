import type { ErrorComponentProps } from "@tanstack/react-router";

import { APP_DISPLAY_NAME } from "../branding";
import { AkeruWordmark } from "../components/AkeruWordmark";
import { Button } from "../components/ui/button";

function reloadApp() {
  window.location.reload();
}

interface RootRouteErrorViewProps extends ErrorComponentProps {
  readonly reload?: () => void;
}

export function RootRouteErrorView({ error, reset, reload = reloadApp }: RootRouteErrorViewProps) {
  const details = errorDetails(error);

  return (
    <main
      aria-labelledby="root-error-title"
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
    >
      <header className="flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1.5 pl-[var(--workspace-controls-left)] pr-[var(--workspace-controls-right)]">
        <AkeruWordmark aria-hidden className="text-2xl text-foreground" />
        <span className="truncate text-sm font-medium tracking-tight text-muted-foreground">
          {APP_DISPLAY_NAME}
        </span>
      </header>

      <section className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-12">
        <div className="flex w-full max-w-md flex-col items-center text-center">
          <h1 className="text-xl font-medium tracking-tight" id="root-error-title">
            This view failed to load
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Retry this view. If it fails again, reload Akeru Bot.
          </p>

          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <Button onClick={() => reset()} size="sm">
              Retry
            </Button>
            <Button onClick={reload} size="sm" variant="outline">
              Reload app
            </Button>
          </div>

          <details className="group mt-5 w-full text-left">
            <summary className="flex cursor-pointer list-none items-center justify-center rounded-[var(--control-radius)] px-2 py-1.5 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background [&::-webkit-details-marker]:hidden">
              Technical details
            </summary>
            <pre
              className="mt-2 max-h-52 overflow-auto rounded-lg border border-border bg-card px-3 py-2.5 font-mono text-xs leading-5 whitespace-pre-wrap text-muted-foreground"
              tabIndex={0}
            >
              {details}
            </pre>
          </details>
        </div>
      </section>
    </main>
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "An unexpected error stopped this view from loading.";
}

export function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return "No additional error details are available.";
  }
}
