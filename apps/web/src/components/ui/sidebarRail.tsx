import * as React from "react";
import * as Schema from "effect/Schema";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useI18n } from "~/i18n";
import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import {
  SidebarInstanceContext,
  type SidebarResolvedResizableOptions,
  useSidebar,
} from "./sidebarContext";

export function clampSidebarWidth(width: number, options: SidebarResolvedResizableOptions): number {
  return Math.max(options.minWidth, Math.min(width, options.maxWidth));
}

export function SidebarRail({
  className,
  onClick,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  ...props
}: React.ComponentProps<"button">) {
  const { open, toggleSidebar } = useSidebar();
  const sidebarInstance = React.use(SidebarInstanceContext);
  const railRef = React.useRef<HTMLButtonElement | null>(null);
  const suppressClickRef = React.useRef(false);
  const resizeStateRef = React.useRef<{
    moved: boolean;
    pointerId: number;
    pendingWidth: number;
    rail: HTMLButtonElement;
    rafId: number | null;
    sidebarRoot: HTMLElement;
    side: "left" | "right";
    startWidth: number;
    startX: number;
    transitionTargets: HTMLElement[];
    width: number;
    wrapper: HTMLElement;
  } | null>(null);
  const resolvedResizable = sidebarInstance?.resizable ?? null;
  const canResize = resolvedResizable !== null && open;
  const { t } = useI18n();
  const railLabel = canResize ? t("Resize Sidebar") : t("Toggle Sidebar");
  const railTitle = canResize ? t("Drag to resize sidebar") : t("Toggle Sidebar");

  const stopResize = React.useCallback(
    (pointerId: number) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState) {
        return;
      }
      if (resizeState.rafId !== null) {
        window.cancelAnimationFrame(resizeState.rafId);
      }
      resizeState.transitionTargets.forEach((element) => {
        element.style.removeProperty("transition-duration");
      });
      if (resolvedResizable?.storageKey && typeof window !== "undefined") {
        setLocalStorageItem(resolvedResizable.storageKey, resizeState.width, Schema.Finite);
      }
      resolvedResizable?.onResize?.(resizeState.width);
      resizeStateRef.current = null;
      if (resizeState.rail.hasPointerCapture(pointerId)) {
        resizeState.rail.releasePointerCapture(pointerId);
      }
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    },
    [resolvedResizable],
  );

  const handlePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      onPointerDown?.(event);
      if (event.defaultPrevented) return;
      if (!resolvedResizable || !open || event.button !== 0) return;

      const wrapper = event.currentTarget.closest<HTMLElement>("[data-slot='sidebar-wrapper']");
      const sidebarRoot = event.currentTarget.closest<HTMLElement>("[data-slot='sidebar']");
      if (!wrapper || !sidebarRoot) {
        return;
      }

      const sidebarContainer = sidebarRoot.querySelector<HTMLElement>(
        "[data-slot='sidebar-container']",
      );
      if (!sidebarContainer) {
        return;
      }

      const startWidth = sidebarContainer.getBoundingClientRect().width;
      const initialWidth = clampSidebarWidth(startWidth, resolvedResizable);
      const transitionTargets = [
        sidebarRoot.querySelector<HTMLElement>("[data-slot='sidebar-gap']"),
        sidebarRoot.querySelector<HTMLElement>("[data-slot='sidebar-container']"),
      ].filter((element): element is HTMLElement => element !== null);
      transitionTargets.forEach((element) => {
        element.style.setProperty("transition-duration", "0ms");
      });

      event.preventDefault();
      event.stopPropagation();
      resizeStateRef.current = {
        moved: false,
        pointerId: event.pointerId,
        pendingWidth: initialWidth,
        rail: event.currentTarget,
        rafId: null,
        sidebarRoot,
        side: sidebarInstance?.side ?? "left",
        startWidth: initialWidth,
        startX: event.clientX,
        transitionTargets,
        width: initialWidth,
        wrapper,
      };
      wrapper.style.setProperty("--sidebar-width", `${initialWidth}px`);
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [onPointerDown, open, resolvedResizable, sidebarInstance?.side],
  );

  const handlePointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      onPointerMove?.(event);
      if (event.defaultPrevented) return;
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId || !resolvedResizable) return;

      event.preventDefault();
      const delta =
        resizeState.side === "right"
          ? resizeState.startX - event.clientX
          : event.clientX - resizeState.startX;
      if (Math.abs(delta) > 2) {
        resizeState.moved = true;
      }
      resizeState.pendingWidth = clampSidebarWidth(
        resizeState.startWidth + delta,
        resolvedResizable,
      );
      if (resizeState.rafId !== null) {
        return;
      }

      resizeState.rafId = window.requestAnimationFrame(() => {
        const activeResizeState = resizeStateRef.current;
        if (!activeResizeState || !resolvedResizable) return;

        activeResizeState.rafId = null;
        const nextWidth = activeResizeState.pendingWidth;
        const accepted =
          resolvedResizable.shouldAcceptWidth?.({
            currentWidth: activeResizeState.width,
            nextWidth,
            rail: activeResizeState.rail,
            side: activeResizeState.side,
            sidebarRoot: activeResizeState.sidebarRoot,
            wrapper: activeResizeState.wrapper,
          }) ?? true;
        if (!accepted) {
          return;
        }

        activeResizeState.wrapper.style.setProperty("--sidebar-width", `${nextWidth}px`);
        activeResizeState.width = nextWidth;
      });
    },
    [onPointerMove, resolvedResizable],
  );

  const endResizeInteraction = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;

      event.preventDefault();
      suppressClickRef.current = resizeState.moved;
      stopResize(event.pointerId);
    },
    [stopResize],
  );

  const handlePointerUp = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      onPointerUp?.(event);
      if (event.defaultPrevented) return;
      endResizeInteraction(event);
    },
    [endResizeInteraction, onPointerUp],
  );

  const handlePointerCancel = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      onPointerCancel?.(event);
      if (event.defaultPrevented) return;
      endResizeInteraction(event);
    },
    [endResizeInteraction, onPointerCancel],
  );

  const handleClick = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) return;
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        event.preventDefault();
        return;
      }
      if (resolvedResizable && open) {
        event.preventDefault();
        return;
      }
      toggleSidebar();
    },
    [onClick, open, resolvedResizable, toggleSidebar],
  );

  React.useLayoutEffect(() => {
    if (!resolvedResizable?.storageKey || typeof window === "undefined") return;
    const rail = railRef.current;
    if (!rail) return;
    const wrapper = rail.closest<HTMLElement>("[data-slot='sidebar-wrapper']");
    if (!wrapper) return;

    let storedWidth: number | null;
    try {
      storedWidth = getLocalStorageItem(resolvedResizable.storageKey, Schema.Finite);
    } catch (error) {
      console.error("Could not restore persisted sidebar width.", error);
      return;
    }
    if (storedWidth === null) return;
    const clampedWidth = clampSidebarWidth(storedWidth, resolvedResizable);
    // Hydrate the CSS variable before the browser paints so a restored sidebar
    // never flashes at the default width first.
    wrapper.style.setProperty("--sidebar-width", `${clampedWidth}px`);
    resolvedResizable.onResize?.(clampedWidth);
  }, [resolvedResizable]);

  React.useEffect(() => {
    return () => {
      const resizeState = resizeStateRef.current;
      if (resizeState?.rafId != null) {
        window.cancelAnimationFrame(resizeState.rafId);
      }
      resizeState?.transitionTargets.forEach((element) => {
        element.style.removeProperty("transition-duration");
      });
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };
  }, []);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-label={railLabel}
            className={cn(
              /* disable pointer events only when offcanvas sidebar is collapsed, that's when the rail sits over the native scrollbar on windows and linux. icon mode stays fully clickable. */
              "-translate-x-1/2 group-data-[side=left]:-right-4 absolute inset-y-0 z-20 hidden w-4 transition-all ease-linear after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] hover:after:bg-sidebar-border group-data-[side=right]:left-0 sm:flex [[data-collapsible=offcanvas][data-state=collapsed]_&]:pointer-events-none",
              "in-data-[side=left]:cursor-w-resize in-data-[side=right]:cursor-e-resize",
              "[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize",
              "group-data-[collapsible=offcanvas]:translate-x-0 hover:group-data-[collapsible=offcanvas]:bg-sidebar group-data-[collapsible=offcanvas]:after:left-full",
              "[[data-side=left][data-collapsible=offcanvas]_&]:-right-2",
              "[[data-side=right][data-collapsible=offcanvas]_&]:-left-2",
              className,
            )}
            data-sidebar="rail"
            data-slot="sidebar-rail"
            onClick={handleClick}
            onPointerCancel={handlePointerCancel}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            ref={railRef}
            tabIndex={-1}
            type="button"
            {...props}
          />
        }
      />
      <TooltipPopup side="right">{railTitle}</TooltipPopup>
    </Tooltip>
  );
}
