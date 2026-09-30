import { environmentCatalog } from "../../connection/catalog";
import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import type { RosterLoadState } from "./rosterRouteSelection";

/**
 * Stands in for the roster until the primary environment's first snapshot
 * lands: a quiet loading line, or the failure reason with Try again, which
 * reconnects the environment. `page` centers it in the main pane.
 */
export function RosterLoadStatus({
  state,
  variant,
}: {
  readonly state: RosterLoadState;
  readonly variant: "sidebar" | "page";
}) {
  const { t } = useI18n();
  const environmentId = usePrimaryEnvironmentId();
  const retryNow = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const muted = variant === "sidebar" ? "text-sidebar-muted-foreground" : "text-muted-foreground";

  return (
    <div
      role="status"
      data-testid={`roster-load-${state.kind}`}
      className={cn(
        "flex flex-col items-center gap-2 px-2 text-center text-sm",
        variant === "page" ? "h-full justify-center py-12" : "py-6",
      )}
    >
      {state.kind === "loading" ? (
        <p className={muted}>{t("Loading bots…")}</p>
      ) : (
        <>
          <p
            className={cn(
              "font-medium",
              variant === "sidebar" ? "text-sidebar-foreground" : "text-foreground",
            )}
          >
            {t("Could not load bots")}
          </p>
          <p className={cn("max-w-80 text-xs", muted)}>{state.message}</p>
          {environmentId !== null ? (
            <Button size="sm" variant="outline" onClick={() => void retryNow(environmentId)}>
              {t("Try again")}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
