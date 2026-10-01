import { BotId } from "@akeru/contracts";
import { useCanGoBack, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

import { isElectron } from "../../env";
import { useI18n } from "../../i18n";
import { botEnvironment } from "../../state/bots";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { SidebarInset } from "../ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { toastManager } from "../ui/toast";
import { BotSettingsForm } from "./BotSettingsForm";
import { useRosterStore } from "./rosterStore";
import type { BotProfileUpdate } from "./useBotProfileDraft";

/**
 * The full settings surface for one bot. Everything a bot owns lives here, in
 * the main content area, so the in-chat panel stays a quick-edit companion
 * rather than the only place these controls fit.
 */
export function BotSettingsPage({ botId }: { readonly botId: string }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const environmentId = usePrimaryEnvironmentId();
  const updateBot = useAtomCommand(botEnvironment.update, { reportFailure: false });
  const bot = useRosterStore((state) =>
    state.bots.find((candidate) => candidate.id === botId && candidate.archivedAt === null),
  );

  const navigateBackWithinApp = useCallback(() => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, navigate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key !== "Escape") return;
      const activeElement = document.activeElement;
      // Let a focused field take Escape first; a second press leaves the page.
      if (activeElement instanceof HTMLElement && activeElement !== document.body) {
        activeElement.blur();
        return;
      }
      event.preventDefault();
      navigateBackWithinApp();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigateBackWithinApp]);

  const onSaveBot = useCallback(
    async (input: BotProfileUpdate) => {
      if (!environmentId || !bot) return false;
      const result = await updateBot({
        environmentId,
        input: { botId: BotId.make(bot.id), ...input },
      });
      if (result._tag === "Failure") {
        toastManager.add({ type: "error", title: t("Could not save bot settings") });
        return false;
      }
      toastManager.add({ type: "success", title: t("Bot settings saved") });
      return true;
    },
    [bot, environmentId, t, updateBot],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border/70">
          <WorkspaceBreadcrumb ariaLabel={t("Bot settings breadcrumb")}>
            <WorkspaceBreadcrumbItem>{t("Bots")}</WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current>
              {bot ? bot.name : t("Unavailable bot")}
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        {bot ? (
          <BotSettingsForm
            key={bot.id}
            bot={bot}
            onSave={onSaveBot}
            onDeleted={navigateBackWithinApp}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
            {t("This bot is no longer available.")}
          </div>
        )}
      </div>
    </SidebarInset>
  );
}
