import { ArrowLeftIcon } from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";

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
import { SETTINGS_NAV_ITEMS } from "./SettingsDialog";
import { isElectron } from "../../env";

export function SettingsSidebarNav() {
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
        <SidebarGroup className="p-[var(--sidebar-content-inset)]">
          <SidebarMenu>
            {SETTINGS_NAV_ITEMS.map((item) => {
              const to = `/settings/${item.section}`;
              const active = pathname === to;
              return (
                <SidebarMenuItem key={item.section}>
                  <SidebarMenuButton
                    aria-current={active ? "page" : undefined}
                    isActive={active}
                    onClick={() => go(to)}
                    tooltip={item.label}
                  >
                    <AppIcon
                      className={cn("size-4", !active && "text-sidebar-muted-foreground")}
                      icon={item.icon}
                    />
                    <span className="truncate group-data-[collapsible=icon]:hidden">
                      {item.label}
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-[var(--sidebar-content-inset)]">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => go("/")} tooltip="Back to chats">
              <ArrowLeftIcon />
              <span className="group-data-[collapsible=icon]:hidden">Back to chats</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}
