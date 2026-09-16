import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  Cancel01Icon,
  PanelRightCloseIcon,
  PanelRightIcon,
  Settings02Icon,
} from "@hugeicons/core-free-icons";
import { useEffect, useReducer, useState, type ReactNode } from "react";

import { resolveShortcutCommand, shortcutLabelForCommand } from "../../keybindings";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../../rightPanelLayout";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { AppIcon } from "../ui/app-icon";
import { Button } from "../ui/button";
import { Sheet, SheetClose, SheetPopup, SheetTitle } from "../ui/sheet";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BotAvatarView } from "./BotAvatarView";
import { BotBrowserPreview } from "./BotBrowserPreview";
import { botPersonalityToneLabel, canonicalizeBotPersonalityTone } from "./botPersonalityTone";
import { botSandboxChoice, botSandboxLabel } from "./botSandbox";
import { RoutinePanel, type RoutinePanelProps } from "./RoutinePanel";
import type { Bot } from "./types";

type BotDetailsPanelState = {
  readonly desktopOpen: boolean;
  readonly mobileOpen: boolean;
};

type BotDetailsPanelAction =
  | { readonly type: "toggle-desktop" }
  | { readonly type: "toggle-mobile" }
  | { readonly type: "set-mobile"; readonly open: boolean };

export function reduceBotDetailsPanelState(
  state: BotDetailsPanelState,
  action: BotDetailsPanelAction,
): BotDetailsPanelState {
  if (action.type === "toggle-desktop") {
    return { ...state, desktopOpen: !state.desktopOpen };
  }
  if (action.type === "toggle-mobile") {
    return { ...state, mobileOpen: !state.mobileOpen };
  }
  return { ...state, mobileOpen: action.open };
}

export {
  parseBotUsageCapInput,
  resolveBotUsageCapForProvider,
  type BotProfileUpdate,
} from "./useBotProfileDraft";

function BotOverview({
  bot,
  onOpenSettings,
  routinePanel,
}: {
  readonly bot: Bot;
  readonly onOpenSettings?: () => void;
  readonly routinePanel?: Omit<RoutinePanelProps, "botName">;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-6">
      <div className="flex flex-col items-center text-center">
        <BotAvatarView avatar={bot.avatar} name={bot.name} className="size-16" />
        <h3 className="mt-3 text-base font-semibold">{bot.name}</h3>
        {bot.label ? <p className="mt-0.5 text-sm text-muted-foreground">{bot.label}</p> : null}
        {bot.description ? (
          <p className="mt-3 line-clamp-3 max-w-64 text-sm leading-relaxed text-muted-foreground">
            {bot.description}
          </p>
        ) : null}
      </div>

      <Button
        className="mt-6 w-full justify-center"
        variant="outline"
        disabled={!onOpenSettings}
        onClick={onOpenSettings}
      >
        <AppIcon className="size-4" icon={Settings02Icon} />
        Open bot settings
      </Button>

      <dl className="mt-6 divide-y divide-border/70 border-y border-border/70 text-sm">
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-muted-foreground">Personality</dt>
          <dd className="font-medium">
            {botPersonalityToneLabel(canonicalizeBotPersonalityTone(bot.personalityTone))}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-muted-foreground">Model</dt>
          <dd className="max-w-44 truncate font-medium">{bot.engine?.model ?? "App default"}</dd>
        </div>
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-muted-foreground">Sandbox</dt>
          <dd className="font-medium">{botSandboxLabel(botSandboxChoice(bot.sandbox))}</dd>
        </div>
      </dl>

      <RoutinePanel botName={bot.name} {...(routinePanel ?? { status: "unavailable" as const })} />
    </div>
  );
}

export function BotDetailsPanel({
  bot,
  onOpenSettings,
  threadRef = null,
  routinePanel,
}: {
  readonly bot: Bot;
  /** Opens the full bot settings page. Omitted when no router is available. */
  readonly onOpenSettings?: () => void;
  readonly threadRef?: ScopedThreadRef | null;
  readonly routinePanel?: Omit<RoutinePanelProps, "botName">;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [panelState, dispatchPanel] = useReducer(reduceBotDetailsPanelState, {
    desktopOpen: true,
    mobileOpen: false,
  });
  const [browserExpanded, setBrowserExpanded] = useState(false);
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
      dispatchPanel({
        type: window.matchMedia(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY).matches
          ? "toggle-mobile"
          : "toggle-desktop",
      });
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [keybindings]);

  const content = (active: boolean, closeButton?: ReactNode, canExpandBrowser = false) => (
    <>
      <BotBrowserPreview
        botName={bot.name}
        threadRef={threadRef}
        expanded={canExpandBrowser && browserExpanded}
        visible={active}
        onExpandedChange={setBrowserExpanded}
        trailingAction={browserExpanded && canExpandBrowser ? closeButton : undefined}
      />
      {!browserExpanded || !canExpandBrowser ? (
        <>
          <header className="relative flex h-[var(--workspace-topbar-height)] shrink-0 items-center justify-center px-4">
            <h2 className="text-sm font-medium">Bot</h2>
            <div className="absolute right-3 flex items-center min-[981px]:fixed min-[981px]:right-[var(--workspace-controls-right)] min-[981px]:top-[var(--workspace-controls-top)] min-[981px]:z-40 min-[981px]:h-[var(--workspace-topbar-height)]">
              {closeButton}
            </div>
          </header>
          <BotOverview
            bot={bot}
            {...(onOpenSettings ? { onOpenSettings } : {})}
            {...(routinePanel ? { routinePanel } : {})}
          />
        </>
      ) : null}
    </>
  );

  return (
    <>
      <aside
        aria-hidden={!panelState.desktopOpen}
        aria-label={`${bot.name} bot sidebar`}
        data-testid="bot-details-panel"
        className={
          panelState.desktopOpen
            ? browserExpanded
              ? "hidden h-full w-[min(48rem,52vw)] shrink-0 flex-col border-l border-border bg-background min-[981px]:flex"
              : "hidden h-full w-88 shrink-0 flex-col border-l border-border bg-background min-[981px]:flex"
            : "hidden"
        }
      >
        {content(
          panelState.desktopOpen,
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-expanded="true"
                  aria-label={`Collapse ${bot.name} bot sidebar`}
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => dispatchPanel({ type: "toggle-desktop" })}
                >
                  <AppIcon icon={PanelRightCloseIcon} />
                </Button>
              }
            />
            <TooltipPopup side="left">
              Collapse{shortcutLabel ? ` (${shortcutLabel})` : ""}
            </TooltipPopup>
          </Tooltip>,
          true,
        )}
      </aside>
      {!panelState.desktopOpen ? (
        <div className="fixed right-[var(--workspace-controls-right)] top-[var(--workspace-controls-top)] z-40 hidden h-[var(--workspace-topbar-height)] items-center min-[981px]:flex">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-expanded="false"
                  aria-label={`Open ${bot.name} bot sidebar`}
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => dispatchPanel({ type: "toggle-desktop" })}
                >
                  <AppIcon icon={PanelRightIcon} />
                </Button>
              }
            />
            <TooltipPopup side="left">
              Open sidebar{shortcutLabel ? ` (${shortcutLabel})` : ""}
            </TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
      <div className="fixed right-[var(--workspace-controls-right)] top-[var(--workspace-controls-top)] z-40 flex h-[var(--workspace-topbar-height)] items-center min-[981px]:hidden">
        <Button
          aria-label={`Open ${bot.name} bot sidebar`}
          size="icon-sm"
          variant="ghost"
          onClick={() => dispatchPanel({ type: "set-mobile", open: true })}
        >
          <AppIcon icon={PanelRightIcon} />
        </Button>
      </div>
      <Sheet
        open={panelState.mobileOpen}
        onOpenChange={(open) => dispatchPanel({ type: "set-mobile", open })}
      >
        <SheetPopup
          className="w-[min(92vw,24rem)] pb-safe pt-safe p-0"
          showCloseButton={false}
          side="right"
        >
          <SheetTitle className="sr-only">{bot.name} overview</SheetTitle>
          {content(
            panelState.mobileOpen,
            <SheetClose
              aria-label="Close bot sidebar"
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
