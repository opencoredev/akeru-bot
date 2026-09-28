import { useAtomValue } from "@effect/atom-react";
import {
  Analytics01Icon,
  BubbleChatIcon,
  Calendar03Icon,
  HelpCircleIcon,
  Moon02Icon,
  PuzzleIcon,
  Settings02Icon,
  Sun03Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";

import { isElectron } from "../../env";
import { useI18n } from "../../i18n";
import { useChangedSinceMount } from "../../hooks/useChangedSinceMount";
import { useClientSettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import { cn, isMacPlatform } from "../../lib/utils";
import { openPlugins } from "../../pluginsDialogStore";
import { openProductFeedback } from "../../productFeedbackStore";
import { openUsage } from "../../usageDialogStore";
import { openSettings } from "../../settingsDialogStore";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { environmentSnapshotAtom } from "../../state/shell";
import BotRosterSidebar from "../roster/BotRosterSidebar";
import { BotAvatarView } from "../roster/BotAvatarView";
import { formatRosterTimestamp } from "../roster/roster.logic";
import { useRosterStore } from "../roster/rosterStore";
import { SettingsPanelNav } from "../settings/SettingsSidebarNav";
import { AppIcon } from "../ui/app-icon";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Codex-style sidebar experiment: a rail of places beside a raised panel.
 * On by default; `?sidebar=classic` on any URL switches back, and the choice
 * sticks in localStorage until `?sidebar=places`.
 */
const EXPERIMENT = "places";
const STORAGE_KEY = "akeru:sidebar-experiment";
const RAIL_WIDTH = 60;
const PANEL_WIDTH = 296;

function readExperiment(): boolean {
  const param = new URLSearchParams(window.location.search).get("sidebar");
  if (param !== null) window.localStorage.setItem(STORAGE_KEY, param);
  return (window.localStorage.getItem(STORAGE_KEY) ?? EXPERIMENT) === EXPERIMENT;
}

/** Resolved once per page load; switching layouts is a reload. */
export function useSidebarExperiment(): boolean {
  const [enabled] = useState(readExperiment);
  return enabled;
}

/** Rail plus panel use a fixed width; resizing is ignored while experimenting. */
export const EXPERIMENTAL_SIDEBAR_WIDTH = RAIL_WIDTH + PANEL_WIDTH;
/** Full-page places such as Plugins show only the rail. */
export const EXPERIMENTAL_RAIL_ONLY_WIDTH = RAIL_WIDTH;

export function isRailOnlyPath(pathname: string): boolean {
  return pathname === "/plugins" || pathname.startsWith("/plugins/");
}

type Place = "chats" | "routines";

export function ExperimentalSidebar() {
  const [place, setPlace] = useState<Place>("chats");
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  // Settings is a route, not a panel toggle: the URL decides whether it owns
  // the panel, and leaving it goes back to the chat workspace.
  const onSettings = pathname === "/settings" || pathname.startsWith("/settings/");
  const onPlugins = isRailOnlyPath(pathname);
  // Collapsing hides the panel and keeps the rail; picking a place brings it back.
  const { state: sidebarState, setOpen: setSidebarOpen } = useSidebar();
  const revealPanel = () => {
    if (sidebarState === "collapsed") setSidebarOpen(true);
  };
  const choosePlace = (next: Place) => {
    setPlace(next);
    revealPanel();
    if (onSettings || onPlugins) void navigate({ to: "/" });
  };
  const isMacosDesktop = isElectron && isMacPlatform(navigator.platform);
  const { resolvedTheme, setAppearanceMode } = useTheme();
  const nextAppearance = resolvedTheme === "dark" ? "light" : "dark";
  const panel = onSettings ? "settings" : place;
  // Only rail switches animate; the first paint of the panel stays still.
  const panelSwitched = useChangedSinceMount(panel);
  const { t } = useI18n();
  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden">
      <nav
        aria-label={t("Main")}
        className="flex h-full shrink-0 flex-col items-center pb-3"
        style={{ width: RAIL_WIDTH }}
      >
        {/* macOS desktop keeps the full titlebar height clear for the traffic
            lights. Elsewhere the first icon centers on the panel title row. */}
        <div
          className={cn(
            "w-full shrink-0",
            isMacosDesktop
              ? "h-[var(--workspace-topbar-height)]"
              : "h-[calc(0.5rem+var(--workspace-topbar-height)/2-1.25rem)]",
            isElectron && "drag-region",
          )}
        />
        <div className="flex flex-col items-center gap-1.5">
          <RailButton
            label={t("Chats")}
            icon={BubbleChatIcon}
            active={!onSettings && !onPlugins && place === "chats"}
            onClick={() => choosePlace("chats")}
          />
          <RailButton
            label={t("Routines")}
            icon={Calendar03Icon}
            active={!onSettings && !onPlugins && place === "routines"}
            onClick={() => choosePlace("routines")}
          />
          <RailButton
            label={t("Plugins")}
            icon={PuzzleIcon}
            active={onPlugins}
            onClick={() => {
              if (!onPlugins) openPlugins();
            }}
          />
          <RailButton label={t("Usage")} icon={Analytics01Icon} onClick={() => openUsage()} />
        </div>
        <div className="mt-auto flex flex-col items-center gap-1.5">
          <RailButton
            label={nextAppearance === "dark" ? t("Switch to dark mode") : t("Switch to light mode")}
            icon={nextAppearance === "dark" ? Moon02Icon : Sun03Icon}
            onClick={() => setAppearanceMode(nextAppearance)}
          />
          <RailButton
            label={t("Feedback")}
            icon={HelpCircleIcon}
            onClick={() => openProductFeedback()}
          />
          <RailButton
            label={t("Settings")}
            icon={Settings02Icon}
            active={onSettings}
            onClick={() => {
              revealPanel();
              if (!onSettings) openSettings();
            }}
          />
        </div>
      </nav>
      {/* The panel is a raised card; its row tokens are re-based on the card surface. */}
      {/* Fixed width so collapsing clips the panel instead of squeezing its rows. */}
      <div
        className={cn("flex shrink-0 py-2 pr-2", onPlugins && "hidden")}
        style={{ width: PANEL_WIDTH }}
      >
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-sidebar-border/70 bg-sidebar shadow-[var(--shell-card-shadow)] [--sidebar-row-active:color-mix(in_srgb,var(--sidebar-foreground)_7%,transparent)] [--sidebar-row-hover:color-mix(in_srgb,var(--sidebar-foreground)_4%,transparent)] [--card:var(--shell-card)] [--sidebar:var(--shell-card)]">
          <div
            key={panel}
            className={cn("flex min-h-0 flex-1 flex-col", panelSwitched && "motion-place-enter")}
          >
            {panel === "settings" ? (
              <>
                <PanelHeader title={t("Settings")} />
                <SettingsPanelNav />
              </>
            ) : panel === "chats" ? (
              <BotRosterSidebar chrome="panel" />
            ) : (
              <RoutinesPanel />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function RailButton({
  label,
  icon,
  active = false,
  onClick,
}: {
  label: string;
  icon: IconSvgElement;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-current={active || undefined}
            onClick={onClick}
            className={cn(
              "flex size-10 cursor-pointer items-center justify-center rounded-xl outline-none transition-[background-color,color,box-shadow] duration-(--duration-fast) ease-(--ease-smooth-out) select-none motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring [-webkit-app-region:no-drag]",
              active
                ? "bg-(--shell-card) text-sidebar-foreground shadow-xs ring-1 ring-sidebar-border/70"
                : "text-sidebar-muted-foreground hover:bg-[color-mix(in_srgb,var(--sidebar-foreground)_6%,transparent)] hover:text-sidebar-foreground",
            )}
          >
            <AppIcon icon={icon} className="size-5" strokeWidth={active ? 2 : 1.7} />
          </button>
        }
      />
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}

function PanelHeader({ title }: { title: string }) {
  return (
    <div
      className={cn(
        "flex h-[var(--workspace-topbar-height)] shrink-0 items-center px-4",
        isElectron && "drag-region",
      )}
    >
      <h2 className="truncate text-[17px] font-semibold tracking-tight text-sidebar-foreground">
        {title}
      </h2>
    </div>
  );
}

function PanelRow({
  onClick,
  leading,
  title,
  detail,
}: {
  onClick: () => void;
  leading: ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <li className="list-none">
      <button
        type="button"
        onClick={onClick}
        className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-2 py-2 text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring"
      >
        {leading}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium text-sidebar-foreground">{title}</span>
          <span className="truncate text-[13px] text-sidebar-muted-foreground">{detail}</span>
        </span>
      </button>
    </li>
  );
}

function useLiveBots() {
  const { bots, pinnedItems } = useRosterStore(
    useShallow((state) => ({ bots: state.bots, pinnedItems: state.pinnedItems })),
  );
  return useMemo(() => {
    const live = bots.filter((bot) => bot.archivedAt === null);
    // Pinned bots lead, in pin order; everything else keeps roster order.
    const pinnedIds = pinnedItems.filter((item) => item.kind === "bot").map((item) => item.id);
    return [
      ...pinnedIds.flatMap((id) => live.filter((bot) => bot.id === id)),
      ...live.filter((bot) => !pinnedIds.includes(bot.id)),
    ];
  }, [bots, pinnedItems]);
}

function RoutinesPanel() {
  const navigate = useNavigate();
  const snapshot = useEnvironmentSnapshot();
  const bots = useLiveBots();
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const { t } = useI18n();
  const routines = (snapshot?.routines ?? []).filter((routine) => routine.lifecycle !== "deleted");
  return (
    <>
      <PanelHeader title={t("Routines")} />
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {routines.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-sidebar-muted-foreground">
            {t("No routines yet. Ask a bot to do something on a schedule.")}
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {routines.map((routine) => {
              const bot = bots.find((candidate) => candidate.id === routine.botId);
              const time = routine.nextRunAt
                ? formatRosterTimestamp(routine.nextRunAt, timestampFormat)
                : null;
              const when = !routine.enabled
                ? t("Paused")
                : time
                  ? t("Next {time}", { time })
                  : t("Not scheduled");
              return (
                <PanelRow
                  key={routine.id}
                  onClick={() =>
                    void navigate({ to: "/bots/$botId", params: { botId: routine.botId } })
                  }
                  leading={
                    bot ? (
                      <BotAvatarView avatar={bot.avatar} name={bot.name} className="size-9" />
                    ) : null
                  }
                  title={routine.job}
                  detail={`${bot?.name ?? t("Unknown bot")} · ${when}`}
                />
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

function useEnvironmentSnapshot() {
  const environmentId = usePrimaryEnvironmentId();
  return useAtomValue(environmentSnapshotAtom(environmentId ?? ("" as never)));
}
