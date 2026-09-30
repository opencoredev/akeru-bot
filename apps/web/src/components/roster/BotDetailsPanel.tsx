import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@akeru/contracts";
import {
  Cancel01Icon,
  ComputerIcon,
  PanelRightCloseIcon,
  PanelRightIcon,
  Settings02Icon,
} from "@hugeicons/core-free-icons";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";

import { openComputerViewer } from "../../computerViewerStore";
import { useI18n } from "../../i18n";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../../keybindings";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../../rightPanelLayout";
import { usePrimarySettings } from "../../hooks/useSettings";
import { primaryServerKeybindingsAtom, primaryServerProvidersAtom } from "../../state/server";
import { AppIcon } from "../ui/app-icon";
import { Button } from "../ui/button";
import { Sheet, SheetClose, SheetPopup, SheetTitle } from "../ui/sheet";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "../../lib/utils";
import { BotAvatarView } from "./BotAvatarView";
import { BotBrowserPreview } from "./BotBrowserPreview";
import { BotChatsSection } from "./BotChatsSection";
import { resolveBotModelLabel } from "./botModelLabel";
import { botPersonalityToneLabel, canonicalizeBotPersonalityTone } from "./botPersonalityTone";
import { botSandboxChoice, botSandboxLabel } from "./botSandbox";
import { RoutinePanel, type RoutinePanelProps } from "./RoutinePanel";
import type { Bot } from "./types";
import { useDetailsPanelState } from "./useDetailsPanelState";
import { useBotDetailsOpen } from "./detailsPanelOpen";

export {
  parseBotUsageCapInput,
  resolveBotUsageCapForProvider,
  type BotProfileUpdate,
} from "./useBotProfileDraft";

export function BotOverview({
  bot,
  onOpenSettings,
  onOpenComputer,
  routinePanel,
  routinePanelRef,
  routinePanelRequest = 0,
  chats,
}: {
  readonly bot: Bot;
  readonly onOpenSettings?: () => void;
  /** Opens the live computer viewer. Omitted until the bot has a chat to attach it to. */
  readonly onOpenComputer?: () => void;
  readonly routinePanel?: Omit<RoutinePanelProps, "botName">;
  readonly routinePanelRequest?: number;
  readonly routinePanelRef?: Ref<HTMLDivElement>;
  /** Lists the bot's recent chats. Omitted where the panel cannot switch chats. */
  readonly chats?: { readonly threadRef: ScopedThreadRef | null; readonly onOpenChat?: () => void };
}) {
  const { t } = useI18n();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const settings = usePrimarySettings();
  const modelLabel = resolveBotModelLabel(bot.engine, settings, providers, t);
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
        {t("Open bot settings")}
      </Button>
      {onOpenComputer ? (
        <Button
          className="mt-2 w-full justify-center"
          variant="outline"
          onClick={onOpenComputer}
          data-bot-open-computer=""
        >
          <AppIcon className="size-4" icon={ComputerIcon} />
          {t("Open computer")}
        </Button>
      ) : null}

      <dl className="mt-6 divide-y divide-border/70 border-y border-border/70 text-sm">
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-muted-foreground">{t("Personality")}</dt>
          <dd className="font-medium">
            {botPersonalityToneLabel(canonicalizeBotPersonalityTone(bot.personalityTone), t)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-muted-foreground">{t("Model")}</dt>
          <dd className="max-w-44 truncate font-medium">{modelLabel}</dd>
        </div>
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-muted-foreground">{t("Sandbox")}</dt>
          <dd className="font-medium">{botSandboxLabel(botSandboxChoice(bot.sandbox), t)}</dd>
        </div>
      </dl>

      {chats ? (
        <BotChatsSection
          botId={bot.id}
          threadRef={chats.threadRef}
          {...(chats.onOpenChat ? { onOpenChat: chats.onOpenChat } : {})}
        />
      ) : null}

      <div ref={routinePanelRef}>
        <RoutinePanel
          botName={bot.name}
          listRequest={routinePanelRequest}
          {...(routinePanel ?? { status: "unavailable" as const })}
        />
      </div>
    </div>
  );
}

export function BotDetailsPanel({
  bot,
  onOpenSettings,
  threadRef = null,
  routinePanel,
  routinePanelRequest = 0,
}: {
  readonly bot: Bot;
  /** Opens the full bot settings page. Omitted when no router is available. */
  readonly onOpenSettings?: () => void;
  readonly threadRef?: ScopedThreadRef | null;
  readonly routinePanel?: Omit<RoutinePanelProps, "botName">;
  readonly routinePanelRequest?: number;
}) {
  const { t } = useI18n();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [desktopOpen, setDesktopOpen] = useBotDetailsOpen(bot.id);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [browserExpanded, setBrowserExpanded] = useState(false);
  const desktopPanel = useDetailsPanelState(desktopOpen);
  const desktopRoutineRef = useRef<HTMLDivElement>(null);
  const mobileRoutineRef = useRef<HTMLDivElement>(null);
  const handledRoutineRequest = useRef(0);
  const shortcutLabel = shortcutLabelForCommand(keybindings, "rightPanel.toggle");

  useEffect(() => {
    if (routinePanelRequest === 0 || handledRoutineRequest.current === routinePanelRequest) return;
    const mobile = window.matchMedia(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY).matches;
    if (mobile && !mobileOpen) {
      setMobileOpen(true);
      return;
    }
    if (!mobile && !desktopOpen) {
      setDesktopOpen(true);
      return;
    }
    if (browserExpanded) {
      setBrowserExpanded(false);
      return;
    }
    const panel = mobile ? mobileRoutineRef.current : desktopRoutineRef.current;
    if (!panel || (!mobile && desktopPanel.state !== "open")) return;
    handledRoutineRequest.current = routinePanelRequest;
    panel.scrollIntoView({ block: "start" });
    panel.querySelector<HTMLElement>("h3[tabindex]")?.focus();
  }, [
    browserExpanded,
    desktopOpen,
    desktopPanel.state,
    mobileOpen,
    routinePanelRequest,
    setDesktopOpen,
  ]);

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

  const content = (
    active: boolean,
    routinePanelRef: Ref<HTMLDivElement>,
    closeButton?: ReactNode,
    canExpandBrowser = false,
    onOpenChat?: () => void,
  ) => (
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
          <header className="relative flex h-[var(--workspace-topbar-height)] shrink-0 items-center justify-center px-4 min-[981px]:h-0">
            <h2 className="text-sm font-medium min-[981px]:sr-only">{t("Bot")}</h2>
            <div className="absolute right-3 flex items-center min-[981px]:fixed min-[981px]:right-[var(--workspace-controls-right)] min-[981px]:top-[var(--workspace-controls-top)] min-[981px]:z-40 min-[981px]:h-[var(--workspace-topbar-height)]">
              {closeButton}
            </div>
          </header>
          <BotOverview
            bot={bot}
            routinePanelRef={routinePanelRef}
            routinePanelRequest={routinePanelRequest}
            {...(onOpenSettings ? { onOpenSettings } : {})}
            {...(threadRef
              ? {
                  onOpenComputer: () =>
                    openComputerViewer({
                      threadRef,
                      botName: bot.name,
                      sandbox: bot.sandbox,
                      engine: bot.engine,
                    }),
                }
              : {})}
            {...(routinePanel ? { routinePanel } : {})}
            chats={{ threadRef, ...(onOpenChat ? { onOpenChat } : {}) }}
          />
        </>
      ) : null}
    </>
  );

  return (
    <>
      <aside
        aria-hidden={!desktopOpen}
        aria-label={t("{name} bot sidebar", { name: bot.name })}
        data-testid="bot-details-panel"
        data-details-panel=""
        data-state={desktopPanel.state}
        onTransitionEnd={desktopPanel.onTransitionEnd}
        className={cn(
          "hidden h-full shrink-0 flex-col items-end overflow-hidden border-l border-border bg-background min-[981px]:flex",
          browserExpanded ? "[--details-width:min(48rem,52vw)]" : "[--details-width:22rem]",
        )}
      >
        <div data-details-column="" className="flex min-h-0 flex-1 flex-col">
          {content(
            desktopPanel.state === "open",
            desktopRoutineRef,
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-expanded="true"
                    aria-label={t("Collapse {name} bot sidebar", { name: bot.name })}
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => setDesktopOpen(false)}
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
            true,
          )}
        </div>
      </aside>
      {!desktopOpen ? (
        <div
          className={cn(
            "fixed right-[var(--workspace-controls-right)] top-[var(--workspace-controls-top)] z-40 hidden h-[var(--workspace-topbar-height)] items-center min-[981px]:flex",
            desktopPanel.toggled && "motion-fade-in",
          )}
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-expanded="false"
                  aria-label={t("Open {name} bot sidebar", { name: bot.name })}
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => setDesktopOpen(true)}
                >
                  <AppIcon icon={PanelRightIcon} />
                </Button>
              }
            />
            <TooltipPopup side="left">
              {shortcutLabel
                ? t("Open sidebar ({shortcut})", { shortcut: shortcutLabel })
                : t("Open sidebar")}
            </TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
      <div className="fixed right-[var(--workspace-controls-right)] top-[var(--workspace-controls-top)] z-40 flex h-[var(--workspace-topbar-height)] items-center min-[981px]:hidden">
        <Button
          aria-label={t("Open {name} bot sidebar", { name: bot.name })}
          size="icon-sm"
          variant="ghost"
          onClick={() => setMobileOpen(true)}
        >
          <AppIcon icon={PanelRightIcon} />
        </Button>
      </div>
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetPopup
          className="w-[min(92vw,24rem)] pb-safe pt-safe p-0"
          showCloseButton={false}
          side="right"
        >
          <SheetTitle className="sr-only">{t("{name} overview", { name: bot.name })}</SheetTitle>
          {content(
            mobileOpen,
            mobileRoutineRef,
            <SheetClose
              aria-label={t("Close bot sidebar")}
              render={<Button size="icon-sm" variant="ghost" />}
            >
              <AppIcon icon={Cancel01Icon} />
            </SheetClose>,
            false,
            () => setMobileOpen(false),
          )}
        </SheetPopup>
      </Sheet>
    </>
  );
}
