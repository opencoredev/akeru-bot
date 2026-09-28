import { Outlet, useLocation } from "@tanstack/react-router";

import { isElectron } from "../../env";
import { useI18n } from "../../i18n";
import { settingsSectionFromPathname } from "../../settingsDialogStore";
import { useSidebarExperiment } from "../sidebar/ExperimentalSidebar";
import { AppIcon } from "../ui/app-icon";
import { SidebarInset } from "../ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SETTINGS_NAV_ITEMS, settingsSectionLabel } from "./SettingsDialog";

export function SettingsRoutePage() {
  const { t } = useI18n();
  const pathname = useLocation({ select: (location) => location.pathname });
  const sidebarExperiment = useSidebarExperiment();
  const section = settingsSectionFromPathname(pathname);
  const navItem = SETTINGS_NAV_ITEMS.find((item) => item.section === section);
  const label = t(settingsSectionLabel(section));

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      {/* No fill here: the experimental shell paints the inset with var(--card), like chat. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col text-foreground">
        {sidebarExperiment ? (
          // The panel already says "Settings"; the card header names the page,
          // the way a chat header names its bot.
          <WorkspacePageHeader electron={isElectron}>
            <h1 className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
              {navItem ? (
                <AppIcon icon={navItem.icon} className="size-4 shrink-0 text-muted-foreground" />
              ) : null}
              <span className="truncate">{label}</span>
            </h1>
          </WorkspacePageHeader>
        ) : (
          <WorkspacePageHeader electron={isElectron} className="border-b border-border/70">
            <WorkspaceBreadcrumb ariaLabel={t("Settings breadcrumb")}>
              <WorkspaceBreadcrumbItem>
                <h1>{t("Settings")}</h1>
              </WorkspaceBreadcrumbItem>
              <WorkspaceBreadcrumbSeparator />
              <WorkspaceBreadcrumbItem current>{label}</WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
          </WorkspacePageHeader>
        )}
        <div className="flex min-h-0 flex-1 flex-col">
          <Outlet />
        </div>
      </div>
    </SidebarInset>
  );
}
