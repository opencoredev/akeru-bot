import { Outlet, useLocation } from "@tanstack/react-router";

import { isElectron } from "../../env";
import { settingsSectionFromPathname } from "../../settingsDialogStore";
import { SidebarInset } from "../ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SETTINGS_NAV_ITEMS } from "./SettingsDialog";

export function SettingsRoutePage() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const section = settingsSectionFromPathname(pathname);
  const label =
    SETTINGS_NAV_ITEMS.find((item) => item.section === section)?.label ??
    section.replaceAll("-", " ");

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border/70">
          <WorkspaceBreadcrumb ariaLabel="Settings breadcrumb">
            <WorkspaceBreadcrumbItem>
              <h1>Settings</h1>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current className="capitalize">
              {label}
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <div className="flex min-h-0 flex-1 flex-col">
          <Outlet />
        </div>
      </div>
    </SidebarInset>
  );
}
