"use client";

import type { PreviewFrame, ScopedThreadRef } from "@t3tools/contracts";
import { Maximize2Icon, MonitorIcon, Minimize2Icon } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import { BrowserSurfaceSlot } from "../../browser/BrowserSurfaceSlot";
import { PreviewPanel } from "../preview/PreviewPanel";
import { usePreviewSession } from "../preview/usePreviewSession";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { isPreviewSupportedInRuntime, useThreadPreviewState } from "../../previewStateStore";
import { cn } from "~/lib/utils";
import {
  botBrowserPreviewRuntimeTabId,
  resolveBotBrowserPreviewStatus,
  type BotBrowserPreviewStatus,
} from "./botBrowserPreview.logic";

/*
 * The bot's screen. Two ideas come from the reference build: the resting card
 * reveals an "Open" affordance instead of a permanently parked button, and Esc
 * collapses the expanded viewer. Everything else stays on Akeru's transport —
 * the native surface in Electron, remote frames on the web.
 *
 * The card is only dark while it is actually showing a page. An idle card that
 * paints itself black reads as a broken screen rather than an empty one, so
 * waiting and failed states rest on the app's own surface.
 */

interface BotBrowserPreviewProps {
  readonly botName: string;
  readonly threadRef: ScopedThreadRef | null;
  readonly expanded: boolean;
  readonly visible: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly trailingAction?: ReactNode;
}

const STATUS_LABELS = {
  unsupported: "Open the desktop app to view the browser.",
  waiting: "The browser appears when the bot opens a page.",
  loading: "Opening page…",
  failed: "The page did not load.",
} as const;

const SCREEN_RADIUS = 12;

/**
 * Whether the card is showing real page content. Only a live card earns the
 * dark surface; every other state keeps the neutral one.
 */
export function isLiveBrowserStatus(status: BotBrowserPreviewStatus): boolean {
  return status === "ready" || status === "loading";
}

export function BotBrowserPreview({
  botName,
  threadRef,
  expanded,
  visible,
  onExpandedChange,
  trailingAction,
}: BotBrowserPreviewProps) {
  const status = resolveBotBrowserPreviewStatus({
    supported: true,
    hasThread: threadRef !== null,
    hasSession: false,
    hasWebContents: false,
    loading: false,
    failed: false,
  });

  if (!threadRef) {
    return (
      <BotBrowserPreviewFrame botName={botName} status={status} trailingAction={trailingAction} />
    );
  }

  return (
    <ConnectedBotBrowserPreview
      botName={botName}
      threadRef={threadRef}
      expanded={expanded}
      visible={visible}
      onExpandedChange={onExpandedChange}
      trailingAction={trailingAction}
    />
  );
}

function ConnectedBotBrowserPreview({
  botName,
  threadRef,
  expanded,
  visible,
  onExpandedChange,
  trailingAction,
}: Omit<BotBrowserPreviewProps, "threadRef"> & { readonly threadRef: ScopedThreadRef }) {
  usePreviewSession(threadRef);
  const previewState = useThreadPreviewState(threadRef);
  const tabId = previewState.activeTabId;
  const snapshot = tabId ? (previewState.sessions[tabId] ?? null) : null;
  const desktopOverlay = tabId ? (previewState.desktopByTabId[tabId] ?? null) : null;
  const nativeSupported = isPreviewSupportedInRuntime();
  const frame = tabId ? (previewState.framesByTabId[tabId] ?? null) : null;
  const failed = snapshot?.navStatus._tag === "LoadFailed";
  const status = resolveBotBrowserPreviewStatus({
    supported: true,
    hasThread: true,
    hasSession: snapshot !== null,
    hasWebContents: nativeSupported ? (desktopOverlay?.hasWebContents ?? false) : frame !== null,
    loading: desktopOverlay?.loading ?? snapshot?.navStatus._tag === "Loading",
    failed,
  });
  const runtimeTabId =
    !nativeSupported || tabId === null
      ? null
      : botBrowserPreviewRuntimeTabId(threadRef, previewState.serverEpoch, tabId);

  // Esc collapses the viewer. Handlers that already consumed the key — dialogs,
  // menus — keep priority.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      onExpandedChange(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [expanded, onExpandedChange]);

  // Expanding replaces the control you just pressed, so focus has to travel
  // with the view and come back to that control on the way out. Queried by
  // attribute rather than held as a ref because the buttons render through
  // Tooltip's `render` prop.
  const expandedRef = useRef<HTMLElement | null>(null);
  const collapsedRef = useRef<HTMLElement | null>(null);
  const wasExpanded = useRef(expanded);
  useEffect(() => {
    if (expanded && !wasExpanded.current) {
      expandedRef.current?.focus();
    } else if (!expanded && wasExpanded.current) {
      collapsedRef.current?.querySelector<HTMLElement>("[data-browser-expand]")?.focus();
    }
    wasExpanded.current = expanded;
  }, [expanded]);

  if (expanded) {
    return (
      <section
        aria-label={`${botName}'s browser`}
        className="flex min-h-0 flex-1 flex-col outline-none"
        data-testid="bot-browser-expanded"
        ref={expandedRef}
        tabIndex={-1}
      >
        <header className="flex h-[var(--workspace-topbar-height)] shrink-0 items-center justify-between gap-3 px-4">
          <h2 className="min-w-0 truncate text-sm font-medium">{botName}'s browser</h2>
          <div className="flex shrink-0 items-center gap-1">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={`Collapse ${botName} browser`}
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => onExpandedChange(false)}
                  />
                }
              >
                <Minimize2Icon />
              </TooltipTrigger>
              <TooltipPopup side="left">Collapse (Esc)</TooltipPopup>
            </Tooltip>
            {trailingAction}
          </div>
        </header>
        <div
          className={cn(
            "relative mx-3 mb-3 min-h-0 flex-1 overflow-hidden rounded-xl border border-border",
            isLiveBrowserStatus(status) ? "bg-zinc-950" : "bg-muted/40",
          )}
        >
          {nativeSupported ? (
            <PreviewPanel mode="embedded" threadRef={threadRef} visible={visible} />
          ) : (
            <BrowserFrame botName={botName} frame={frame} status={status} className="size-full" />
          )}
        </div>
      </section>
    );
  }

  return (
    <BotBrowserPreviewFrame
      botName={botName}
      status={status}
      runtimeTabId={runtimeTabId}
      frame={nativeSupported ? null : frame}
      browserVisible={visible && Boolean(desktopOverlay?.hasWebContents) && !failed}
      onExpand={() => onExpandedChange(true)}
      trailingAction={trailingAction}
      sectionRef={collapsedRef}
    />
  );
}

function BotBrowserPreviewFrame({
  botName,
  status,
  runtimeTabId = null,
  frame = null,
  browserVisible = false,
  onExpand,
  trailingAction,
  sectionRef,
}: {
  readonly botName: string;
  readonly status: BotBrowserPreviewStatus;
  readonly runtimeTabId?: string | null;
  readonly frame?: PreviewFrame | null;
  readonly browserVisible?: boolean;
  readonly onExpand?: () => void;
  readonly trailingAction?: ReactNode;
  readonly sectionRef?: React.MutableRefObject<HTMLElement | null>;
}) {
  const live = isLiveBrowserStatus(status);
  const showBrowser = runtimeTabId !== null && live;
  const showFrame = frame !== null && live;
  const canOpen = onExpand !== undefined && live;

  return (
    <section className="shrink-0 px-4 pt-4" data-testid="bot-browser-preview" ref={sectionRef}>
      <div className="mb-2 flex min-h-7 items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{botName}'s browser</h2>
        {canOpen ? (
          // The native surface paints above the DOM in Electron, so a hover-only
          // affordance would be unreachable there. This keeps Open beside the label.
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={`Expand ${botName} browser`}
                  data-browser-expand=""
                  size="icon-sm"
                  variant="ghost"
                  onClick={onExpand}
                />
              }
            >
              <Maximize2Icon />
            </TooltipTrigger>
            <TooltipPopup side="left">Open</TooltipPopup>
          </Tooltip>
        ) : null}
        {trailingAction}
      </div>
      <div
        className={cn(
          "group/screen relative aspect-video overflow-hidden rounded-xl border border-border transition-shadow",
          live ? "bg-zinc-950" : "bg-muted/40",
          canOpen && "cursor-pointer hover:shadow-sm",
        )}
        onClick={canOpen ? onExpand : undefined}
      >
        {showBrowser ? (
          <BrowserSurfaceSlot
            tabId={runtimeTabId}
            visible={browserVisible}
            cornerRadius={SCREEN_RADIUS}
            fitSourceContent
            className="absolute inset-0"
          />
        ) : null}
        {showFrame && frame ? <RemoteFrame botName={botName} frame={frame} /> : null}
        <ScreenStatus status={status} />
        {canOpen ? (
          <div className="absolute inset-0 z-40 flex items-center justify-center bg-zinc-950/0 transition-colors group-focus-within/screen:bg-zinc-950/25 group-hover/screen:bg-zinc-950/25">
            <Button
              aria-label={`Open ${botName} browser`}
              className="translate-y-1 opacity-0 transition group-focus-within/screen:translate-y-0 group-focus-within/screen:opacity-100 group-hover/screen:translate-y-0 group-hover/screen:opacity-100"
              size="xs"
              variant="secondary"
              onClick={(event) => {
                event.stopPropagation();
                onExpand();
              }}
            >
              <Maximize2Icon />
              Open
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function RemoteFrame({
  botName,
  frame,
}: {
  readonly botName: string;
  readonly frame: PreviewFrame;
}) {
  return (
    <img
      alt={`${botName} browser`}
      className="absolute inset-0 size-full object-contain"
      data-testid="bot-browser-remote-frame"
      src={`data:${frame.mimeType};base64,${frame.data}`}
    />
  );
}

/**
 * What the card says when it is not simply showing a page. A live card that is
 * still opening keeps its dark surface and dims; an idle one explains itself on
 * the neutral surface with the screen glyph the empty state deserves.
 */
function ScreenStatus({ status }: { readonly status: BotBrowserPreviewStatus }) {
  if (status === "ready") return null;

  if (status === "loading") {
    return (
      <div
        className="pointer-events-none absolute inset-0 flex items-center justify-center bg-zinc-950/70 px-6 text-center text-xs text-zinc-300"
        role="status"
      >
        {STATUS_LABELS.loading}
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
      <MonitorIcon aria-hidden className="size-5 text-muted-foreground/70" />
      <span className="text-xs text-muted-foreground">{STATUS_LABELS[status]}</span>
    </div>
  );
}

function BrowserFrame({
  botName,
  frame,
  status,
  className,
}: {
  readonly botName: string;
  readonly frame: PreviewFrame | null;
  readonly status: BotBrowserPreviewStatus;
  readonly className: string;
}) {
  return (
    <div className={cn("relative overflow-hidden", className)}>
      {frame ? <RemoteFrame botName={botName} frame={frame} /> : null}
      <ScreenStatus status={status} />
    </div>
  );
}
