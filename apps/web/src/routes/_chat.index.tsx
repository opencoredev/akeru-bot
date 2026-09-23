import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { LinkIcon, PlusIcon } from "lucide-react";
import { useEffect } from "react";

import { APP_DISPLAY_NAME } from "~/branding";
import { BotZeroState } from "../components/roster/BotZeroState";
import { resolveRosterBotId } from "../components/roster/roster.logic";
import { isRosterReady } from "../components/roster/rosterRouteSelection";
import { useRosterStore } from "../components/roster/rosterStore";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { useI18n } from "../i18n";
import { openSettings } from "../settingsDialogStore";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const { environments } = useEnvironments();

  if (authGateState.status === "hosted-static" && environments.length === 0) {
    return <HostedStaticOnboardingState />;
  }

  return <BotIndexRedirect />;
}

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
  component: ChatIndexRouteView,
});

function HostedStaticOnboardingState() {
  const { t } = useI18n();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader className="border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
              {APP_DISPLAY_NAME}
            </span>
          </div>
        </WorkspacePageHeader>

        <Empty className="flex-1">
          <div className="w-full max-w-xl rounded-3xl border border-border/55 bg-card/20 px-8 py-12 shadow-sm/5">
            <EmptyHeader className="max-w-none">
              <div className="mx-auto mb-5 flex size-11 items-center justify-center rounded-xl border border-border/70 bg-background/70 text-muted-foreground">
                <LinkIcon className="size-5" />
              </div>
              <EmptyTitle className="text-foreground text-xl">
                {t("Connect an environment to get started")}
              </EmptyTitle>
              <EmptyDescription className="mt-2 text-sm leading-relaxed text-muted-foreground/78">
                {t("Add a reachable backend manually to start working from this browser.")}
              </EmptyDescription>
              <div className="mt-6 flex justify-center">
                <Button size="sm" onClick={() => openSettings("connections")}>
                  <PlusIcon className="size-4" />
                  {t("Add environment")}
                </Button>
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
