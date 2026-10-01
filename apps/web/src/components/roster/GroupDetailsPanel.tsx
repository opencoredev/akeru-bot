import { useAtomValue } from "@effect/atom-react";
import { type EnvironmentId } from "@akeru/contracts";
import { Cancel01Icon, PanelRightCloseIcon, PanelRightIcon } from "@hugeicons/core-free-icons";
import { useEffect, useState, type ReactNode } from "react";

import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../../keybindings";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../../rightPanelLayout";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { AppIcon } from "../ui/app-icon";
import { Button } from "../ui/button";
import { Sheet, SheetClose, SheetPopup, SheetTitle } from "../ui/sheet";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { Bot, Group } from "./types";
import { useDetailsPanelState } from "./useDetailsPanelState";
import { useGroupDetailsOpen } from "./detailsPanelOpen";
import { GroupEditor } from "./GroupEditor";

export { groupMemberRemovalHint, isGroupMemberRemovalBlocked } from "./groupMemberRemoval.logic";

export function GroupDetailsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly group: Group;
  readonly bots: readonly Bot[];
  readonly onDeleted: () => void;
}) {
  const { t } = useI18n();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [desktopOpen, setDesktopOpen] = useGroupDetailsOpen();
  const [mobileOpen, setMobileOpen] = useState(false);
  const desktopPanel = useDetailsPanelState(desktopOpen);
  const shortcutLabel = shortcutLabelForCommand(keybindings, "rightPanel.toggle");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;

      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }

      if (resolveShortcutCommand(event, keybindings) !== "rightPanel.toggle") return;
      event.preventDefault();
      event.stopPropagation();

      if (window.matchMedia(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY).matches) {
        setMobileOpen((open) => !open);
      } else {
        setDesktopOpen((open) => !open);
      }
    };

    window.addEventListener("keydown", onKeyDown, true);

    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [keybindings, setDesktopOpen]);

  const content = (closeButton?: ReactNode) => (
    <>
      <header className="relative flex h-(--workspace-topbar-height) shrink-0 items-center justify-center px-4">
        <h2 className="text-sm font-medium">{t("Group")}</h2>
        <div className="absolute right-3 flex items-center min-[981px]:fixed min-[981px]:right-(--workspace-controls-right) min-[981px]:top-(--workspace-controls-top) min-[981px]:z-40 min-[981px]:h-(--workspace-topbar-height)">
          {closeButton}
        </div>
      </header>
      <GroupEditor {...props} />
    </>
  );

  return (
    <>
      <aside
        aria-hidden={!desktopOpen}
        aria-label={t("{name} group sidebar", { name: props.group.name })}
        data-testid="group-details-panel"
        data-details-panel=""
        data-state={desktopPanel.state}
        onTransitionEnd={desktopPanel.onTransitionEnd}
        className="hidden h-full shrink-0 flex-col items-end overflow-hidden border-l border-border bg-background [--details-width:22rem] min-[981px]:flex"
      >
        <div data-details-column="" className="flex min-h-0 flex-1 flex-col">
          {content(
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-expanded="true"
                    aria-label={t("Collapse {name} group sidebar", { name: props.group.name })}
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => setDesktopOpen((open) => !open)}
                  >
                    <AppIcon icon={PanelRightCloseIcon} />
                  </Button>
                }
              />
              <TooltipPopup side="left">
                {shortcutLabel
                  ? t("Collapse ({shortcut})", { shortcut: shortcutLabel })
                  : t("Collapse")}
              </TooltipPopup>
            </Tooltip>,
          )}
        </div>
      </aside>
      {!desktopOpen ? (
        <div
          className={cn(
            "fixed right-(--workspace-controls-right) top-(--workspace-controls-top) z-40 hidden h-(--workspace-topbar-height) items-center min-[981px]:flex",
            desktopPanel.toggled && "motion-fade-in",
          )}
        >
          <Button
            aria-label={t("Open {name} group sidebar", { name: props.group.name })}
            size="icon-sm"
            variant="ghost"
            onClick={() => setDesktopOpen((open) => !open)}
          >
            <AppIcon icon={PanelRightIcon} />
          </Button>
        </div>
      ) : null}
      <div className="fixed right-(--workspace-controls-right) top-(--workspace-controls-top) z-40 flex h-(--workspace-topbar-height) items-center min-[981px]:hidden">
        <Button
          aria-label={t("Open {name} group sidebar", { name: props.group.name })}
          size="icon-sm"
          variant="ghost"
          onClick={() => setMobileOpen(true)}
        >
          <AppIcon icon={PanelRightIcon} />
        </Button>
      </div>
      <Sheet open={mobileOpen} onOpenChange={(open) => setMobileOpen(open)}>
        <SheetPopup
          className="w-[min(92vw,24rem)] pb-safe pt-safe p-0"
          showCloseButton={false}
          side="right"
        >
          <SheetTitle className="sr-only">
            {t("Edit {name}", { name: props.group.name })}
          </SheetTitle>
          {content(
            <SheetClose
              aria-label={t("Close group sidebar")}
              render={<Button size="icon-sm" variant="ghost" />}
            >
              <AppIcon icon={Cancel01Icon} />
            </SheetClose>,
          )}
        </SheetPopup>
      </Sheet>
    </>
  );
}
