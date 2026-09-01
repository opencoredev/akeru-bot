"use client";

import type { PreviewFrame, ScopedThreadRef } from "@t3tools/contracts";
import { Maximize2Icon, Minimize2Icon } from "lucide-react";
import type { ReactNode } from "react";

import { BrowserSurfaceSlot } from "../../browser/BrowserSurfaceSlot";
import { PreviewPanel } from "../preview/PreviewPanel";
import { usePreviewSession } from "../preview/usePreviewSession";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { isPreviewSupportedInRuntime, useThreadPreviewState } from "../../previewStateStore";
import {
  botBrowserPreviewRuntimeTabId,
  resolveBotBrowserPreviewStatus,
} from "./botBrowserPreview.logic";

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
  connecting: "Connecting browser...",
  waiting: "The browser appears when the bot opens a page.",
  loading: "Opening page...",
  failed: "The page did not load.",
} as const;

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

  if (expanded) {
    return (
      <section className="flex min-h-0 flex-1 flex-col" data-testid="bot-browser-expanded">
        <header className="flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-2 px-3">
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{botName}'s browser</h2>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={`Restore ${botName} browser preview`}
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => onExpandedChange(false)}
                />
              }
            >
              <Minimize2Icon />
            </TooltipTrigger>
            <TooltipPopup side="left">Restore preview</TooltipPopup>
          </Tooltip>
          {trailingAction}
        </header>
        <div className="min-h-0 flex-1 overflow-hidden border-t border-border">
          {nativeSupported ? (
            <PreviewPanel mode="embedded" threadRef={threadRef} visible={visible} />
          ) : (
            <BrowserFrame
              botName={botName}
              frame={frame}
              status={status}
              className="size-full rounded-none"
            />
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
}: {
  readonly botName: string;
  readonly status: ReturnType<typeof resolveBotBrowserPreviewStatus>;
  readonly runtimeTabId?: string | null;
  readonly frame?: PreviewFrame | null;
  readonly browserVisible?: boolean;
  readonly onExpand?: () => void;
  readonly trailingAction?: ReactNode;
}) {
  const showBrowser = runtimeTabId !== null && (status === "ready" || status === "loading");
  const showFrame = frame !== null && (status === "ready" || status === "loading");

  return (
    <section className="shrink-0 px-3 pt-3" data-testid="bot-browser-preview">
      <div className="mb-2 flex min-h-7 items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{botName}'s browser</h2>
        {onExpand ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={`Expand ${botName} browser`}
                  size="icon-xs"
                  variant="ghost"
                  onClick={onExpand}
                />
              }
            >
              <Maximize2Icon />
            </TooltipTrigger>
            <TooltipPopup side="left">Expand browser</TooltipPopup>
          </Tooltip>
        ) : null}
        {trailingAction}
      </div>
      <BrowserFrame
        botName={botName}
        frame={showFrame ? frame : null}
        status={status}
        className="aspect-video rounded-xl shadow-sm ring-1 ring-inset ring-white/10"
      >
        {showBrowser ? (
          <BrowserSurfaceSlot
            tabId={runtimeTabId}
            visible={browserVisible}
            cornerRadius={12}
            fitSourceContent
            className="absolute inset-0"
          />
        ) : null}
      </BrowserFrame>
    </section>
  );
}

function BrowserFrame({
  botName,
  frame,
  status,
  className,
  children,
}: {
  readonly botName: string;
  readonly frame: PreviewFrame | null;
  readonly status: ReturnType<typeof resolveBotBrowserPreviewStatus>;
  readonly className: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className={`relative overflow-hidden bg-zinc-950 ${className}`}>
      {children}
      {frame ? (
        <img
          alt={`${botName} browser`}
          className="absolute inset-0 size-full object-contain"
          data-testid="bot-browser-remote-frame"
          src={`data:${frame.mimeType};base64,${frame.data}`}
        />
      ) : null}
      {status !== "ready" ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-zinc-950/88 px-6 text-center text-xs text-zinc-400">
          {STATUS_LABELS[status]}
        </div>
      ) : null}
    </div>
  );
}
