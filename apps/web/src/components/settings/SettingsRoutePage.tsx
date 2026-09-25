import { Outlet, useLocation } from "@tanstack/react-router";

import { isElectron } from "../../env";
import { useI18n } from "../../i18n";
import { settingsSectionFromPathname } from "../../settingsDialogStore";
import { SidebarInset } from "../ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SETTINGS_NAV_ITEMS } from "./SettingsDialog";

/** The breadcrumb label for a settings section, translated like the nav and in its sentence case. */
export function settingsBreadcrumbLabel(
  section: string,
  t: (message: string) => string = (message) => message,
): string {
  const navLabel = SETTINGS_NAV_ITEMS.find((item) => item.section === section)?.label;
  if (navLabel) return t(navLabel);
  const words = section.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function SettingsRoutePage() {
  const { t } = useI18n();
  const pathname = useLocation({ select: (location) => location.pathname });
  const label = settingsBreadcrumbLabel(settingsSectionFromPathname(pathname), t);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border/70">
          <WorkspaceBreadcrumb ariaLabel={t("Settings breadcrumb")}>
            <WorkspaceBreadcrumbItem>
              <h1>{t("Settings")}</h1>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current>{label}</WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <div className="flex min-h-0 flex-1 flex-col">
          <Outlet />
        </div>
      </div>
    </SidebarInset>
  );
}
