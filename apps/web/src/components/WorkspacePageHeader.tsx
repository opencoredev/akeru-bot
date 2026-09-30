import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";

/**
 * Right inset for a header that a details panel toggle floats over. The toggle
 * is always fixed at the top-right below the inline breakpoint, and on wider
 * screens only while the desktop panel is closed.
 */
export function detailsToggleInsetClass(detailsPanelOpen: boolean | undefined): string | null {
  if (detailsPanelOpen === undefined) return null;
  return detailsPanelOpen
    ? "max-[980px]:pr-[calc(var(--workspace-controls-right)+var(--workspace-titlebar-control-size)+var(--workspace-titlebar-control-gap))]!"
    : "pr-[calc(var(--workspace-controls-right)+var(--workspace-titlebar-control-size)+var(--workspace-titlebar-control-gap))]!";
}

/** Shared workspace top-bar geometry. */
export function WorkspacePageHeader({
  electron = false,
  reserveNativeControls = electron,
  detailsPanelOpen,
  className,
  ...props
}: ComponentPropsWithoutRef<"header"> & {
  readonly electron?: boolean;
  readonly reserveNativeControls?: boolean;
  /** Set on pages with a bot or group details panel so its toggle never covers header actions. */
  readonly detailsPanelOpen?: boolean;
}) {
  return (
    <header
      data-workspace-header=""
      className={cn(
        "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-3 pl-[calc(env(safe-area-inset-left)+0.75rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:pl-[calc(env(safe-area-inset-left)+1.25rem)] sm:pr-[calc(env(safe-area-inset-right)+1.25rem)]",
        electron && "drag-region",
        reserveNativeControls && "wco:pr-[var(--workspace-native-controls-inset)]",
        COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        // Below md the main sidebar hides and a fixed toggle sits at the left
        // edge of the top bar, so the title starts after it.
        "max-md:pl-[calc(var(--workspace-controls-left)+var(--workspace-titlebar-control-size)+var(--workspace-titlebar-control-gap))]!",
        detailsToggleInsetClass(detailsPanelOpen),
        className,
      )}
      {...props}
    />
  );
}
