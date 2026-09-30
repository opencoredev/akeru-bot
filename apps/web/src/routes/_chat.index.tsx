import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { APP_DISPLAY_NAME } from "../branding";
import { BotZeroState } from "../components/roster/BotZeroState";
import { resolveRosterBotId } from "../components/roster/roster.logic";
import { isRosterReady } from "../components/roster/rosterRouteSelection";
import { RosterLoadStatus } from "../components/roster/RosterLoadStatus";
import { useRosterStore } from "../components/roster/rosterStore";
import { useRosterLoadState } from "../components/roster/useServerRoster";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { usePrimaryEnvironmentId } from "../state/environments";

function BotIndexRedirect() {
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const rosterEnvironmentId = useRosterStore((state) => state.environmentId);
  const rosterReady = isRosterReady(environmentId, rosterEnvironmentId);
  const botId = useRosterStore((state) => resolveRosterBotId(state.selectedBotId, state.bots));
  const loadState = useRosterLoadState();

  useEffect(() => {
    if (!rosterReady || botId === null) return;
    void navigate({ to: "/bots/$botId", params: { botId }, replace: true });
  }, [botId, navigate, rosterReady]);

  if (botId !== null && rosterReady) return null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader className="border-b border-border">
          <span className="text-sm font-medium text-muted-foreground">{APP_DISPLAY_NAME}</span>
        </WorkspacePageHeader>
        {rosterReady ? <BotZeroState /> : <RosterLoadStatus state={loadState} variant="page" />}
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: BotIndexRedirect,
});
