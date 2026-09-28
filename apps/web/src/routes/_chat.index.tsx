import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { BotZeroState } from "../components/roster/BotZeroState";
import { resolveRosterBotId } from "../components/roster/roster.logic";
import { isRosterReady } from "../components/roster/rosterRouteSelection";
import { useRosterStore } from "../components/roster/rosterStore";
import { Empty, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { usePrimaryEnvironmentId } from "../state/environments";

function BotIndexRedirect() {
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const rosterEnvironmentId = useRosterStore((state) => state.environmentId);
  const rosterReady = isRosterReady(environmentId, rosterEnvironmentId);
  const botId = useRosterStore((state) => resolveRosterBotId(state.selectedBotId, state.bots));

  useEffect(() => {
    if (!rosterReady || botId === null) return;
    void navigate({ to: "/bots/$botId", params: { botId }, replace: true });
  }, [botId, navigate, rosterReady]);

  if (!rosterReady || botId !== null) return null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <BotZeroState />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: BotIndexRedirect,
});
