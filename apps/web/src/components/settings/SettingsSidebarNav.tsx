import { ArrowLeftIcon } from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";
import { AppIcon } from "../ui/app-icon";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";
import { SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { SETTINGS_NAV_GROUPS } from "./SettingsDialog";
import { isElectron } from "../../env";

function useSettingsNavigation() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const go = (to: string) => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to });
  };
  return { pathname, go };
}

/**
 * Section list for the rail layout's raised panel. The rail owns the way back
 * to chats, so there is no footer here.
 */
export function SettingsPanelNav() {
  const { t } = useI18n();
  const { pathname, go } = useSettingsNavigation();
  return (
    <nav aria-label={t("Settings sections")} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      {SETTINGS_NAV_GROUPS.map((group) => (
        <div key={group.label} className="pb-2">
          <div className="px-2.5 pt-2 pb-1 text-xs font-medium text-sidebar-muted-foreground">
            {t(group.label)}
          </div>
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const to = `/settings/${item.section}`;
              const active = pathname === to || pathname.startsWith(`${to}/`);
              return (
                <li key={item.section} className="list-none">
                  <button
                    type="button"
                    aria-current={active ? "page" : undefined}
                    onClick={() => go(to)}
                    className={cn(
                      "flex h-9 w-full cursor-pointer items-center gap-3 rounded-xl px-2.5 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                      active
                        ? "bg-sidebar-row-active font-medium text-sidebar-foreground"
                        : "text-sidebar-foreground/85 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                    )}
                  >
                    <AppIcon
                      className={cn(
                        "size-[18px] shrink-0",
                        active ? "text-sidebar-foreground" : "text-sidebar-muted-foreground",
                      )}
                      icon={item.icon}
                      strokeWidth={active ? 2 : 1.7}
                    />
                    <span className="truncate">{t(item.label)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** Classic flat sidebar (`?sidebar=classic`) for the settings route. */
export function SettingsSidebarNav() {
  const { t } = useI18n();
  const { pathname, go } = useSettingsNavigation();

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent className="overflow-x-hidden">
        {SETTINGS_NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label} className="p-[var(--sidebar-content-inset)]">
            <SidebarGroupLabel>{t(group.label)}</SidebarGroupLabel>
            <SidebarMenu>
              {group.items.map((item) => {
                const to = `/settings/${item.section}`;
                const active = pathname === to || pathname.startsWith(`${to}/`);
                return (
                  <SidebarMenuItem key={item.section}>
                    <SidebarMenuButton
                      aria-current={active ? "page" : undefined}
                      isActive={active}
                      onClick={() => go(to)}
                      tooltip={t(item.label)}
                    >
                      <AppIcon
                        className={cn("size-4", !active && "text-sidebar-muted-foreground")}
                        icon={item.icon}
                      />
                      <span className="truncate group-data-[collapsible=icon]:hidden">
                        {t(item.label)}
                      </span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter className="p-[var(--sidebar-content-inset)]">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => go("/")} tooltip={t("Back to chats")}>
              <ArrowLeftIcon />
              <span className="group-data-[collapsible=icon]:hidden">{t("Back to chats")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}
