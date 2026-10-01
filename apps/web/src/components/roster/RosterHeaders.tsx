import { PencilEdit02Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import { BotIcon, PlusIcon, UsersIcon } from "lucide-react";
import { memo } from "react";

import { isElectron } from "../../env";
import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";
import { AkeruWordmark } from "../AkeruWordmark";
import { AppIcon } from "../ui/app-icon";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SidebarHeader, SidebarTrigger } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Minimal roster chrome: traffic-light drag space, an optional environment
 * pill, and the new-bot button. No brand row and no stage artwork. The
 * fixed SidebarControl trigger overlays the left edge on desktop, so content
 * starts at the titlebar inset. Icon-collapsed mode empties the row and the
 * rail supplies its own new-bot button.
 */
export const RosterSidebarHeader = memo(function RosterSidebarHeader({
  onNewBot,
  onNewGroup,
}: {
  onNewBot: () => void;
  onNewGroup: () => void;
}) {
  const { t } = useI18n();
  return (
    <SidebarHeader
      className={cn(
        "h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-1 px-3 py-0 md:px-2",
        isElectron && "drag-region",
      )}
    >
      <div className="grid min-w-0 flex-1 grid-cols-[1fr_auto_1fr] items-center group-data-[collapsible=icon]:hidden">
        <div className="flex items-center justify-start">
          <SidebarTrigger className="md:hidden" />
        </div>
        <Link
          to="/"
          className="flex items-center justify-center rounded-md text-sidebar-foreground outline-none ring-ring focus-visible:ring-2 [-webkit-app-region:no-drag]"
        >
          <AkeruWordmark />
        </Link>
        <div className="flex items-center justify-end">
          <Menu>
            <MenuTrigger
              render={
                <Button
                  aria-label={t("Create")}
                  data-testid="roster-new-bot"
                  className="size-[var(--workspace-titlebar-control-size)]! [-webkit-app-region:no-drag]"
                  size="icon"
                  variant="ghost"
                >
                  <PlusIcon />
                </Button>
              }
            />
            <MenuPopup align="end">
              <MenuItem onClick={onNewBot}>
                <BotIcon />
                {t("New bot")}
              </MenuItem>
              <MenuItem onClick={onNewGroup}>
                <UsersIcon />
                {t("New group")}
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </div>
    </SidebarHeader>
  );
});

/**
 * Header for the roster when it sits inside the experimental rail layout:
 * the wordmark as the panel title, with search and create beside it.
 */
export function RosterPanelHeader({
  onNewBot,
  onNewGroup,
  onSearch,
}: {
  onNewBot: () => void;
  onNewGroup: () => void;
  onSearch: () => void;
}) {
  const { t } = useI18n();
  const iconButton =
    "size-8! rounded-lg text-sidebar-muted-foreground hover:text-sidebar-foreground [-webkit-app-region:no-drag]";
  return (
    <SidebarHeader
      className={cn(
        "h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-1 py-0 pl-4 pr-2.5",
        isElectron && "drag-region",
      )}
    >
      <Link
        to="/"
        className="min-w-0 flex-1 rounded-md text-sidebar-foreground outline-none ring-ring focus-visible:ring-2 [-webkit-app-region:no-drag]"
      >
        <AkeruWordmark className="text-[26px]" />
      </Link>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={t("Search")}
              className={iconButton}
              size="icon"
              variant="ghost"
              onClick={onSearch}
            >
              <AppIcon icon={Search01Icon} className="size-[18px]" />
            </Button>
          }
        />
        <TooltipPopup>{t("Search")}</TooltipPopup>
      </Tooltip>
      <Menu>
        <MenuTrigger
          render={
            <Button
              aria-label={t("Create")}
              data-testid="roster-new-bot"
              className={iconButton}
              size="icon"
              variant="ghost"
            >
              <AppIcon icon={PencilEdit02Icon} className="size-[18px]" />
            </Button>
          }
        />
        <MenuPopup align="end">
          <MenuItem onClick={onNewBot}>
            <BotIcon />
            {t("New bot")}
          </MenuItem>
          <MenuItem onClick={onNewGroup}>
            <UsersIcon />
            {t("New group")}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </SidebarHeader>
  );
}

/** Create menu for the icon-collapsed rail, pinned above the sidebar footer. */
export function RosterRailCreateMenu({
  onNewBot,
  onNewGroup,
}: {
  onNewBot: () => void;
  onNewGroup: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="hidden shrink-0 flex-col items-center pb-1 group-data-[collapsible=icon]:flex">
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label={t("Create")}
              className="flex size-9 cursor-pointer items-center justify-center rounded-lg text-sidebar-muted-foreground outline-none select-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <PlusIcon className="size-4" />
            </button>
          }
        />
        <MenuPopup align="end" side="right">
          <MenuItem onClick={onNewBot}>
            <BotIcon />
            {t("New bot")}
          </MenuItem>
          <MenuItem onClick={onNewGroup}>
            <UsersIcon />
            {t("New group")}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}
