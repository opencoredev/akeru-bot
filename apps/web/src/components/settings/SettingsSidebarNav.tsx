import { ArrowLeftIcon } from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";
import { AppIcon } from "../ui/app-icon";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";
import { SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { SETTINGS_NAV_GROUPS } from "./SettingsDialog";
import { isElectron } from "../../env";

export function SettingsSidebarNav() {
  const { t } = useI18n();
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const go = (to: string) => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to });
  };

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent className="overflow-x-hidden">
        {SETTINGS_NAV_GROUPS.map((group) => (
          <SidebarGroup
            key={group.id}
            className="p-[var(--sidebar-content-inset)] pb-0 last:pb-[var(--sidebar-content-inset)]"
          >
            <div className="px-[var(--sidebar-row-content-inset)] pb-1 text-[11px] font-medium uppercase tracking-wide text-sidebar-muted-foreground/70 group-data-[collapsible=icon]:hidden">
              {t(group.label)}
            </div>
            <SidebarMenu>
              {group.items.map((item) => {
                const to = `/settings/${item.section}`;
                const active = pathname === to;
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
