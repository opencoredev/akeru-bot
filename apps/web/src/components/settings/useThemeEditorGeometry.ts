import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

const VIEWPORT_MARGIN = 8;
const MIN_WIDTH = 280;
const MIN_HEIGHT = 220;

/**
 * Drag and corner-resize geometry for the floating theme editor. Spread
 * `dragHandlers` on the header and `resizeHandlers` on the corner grip, and
 * attach `panelRef` to the panel. Null `position` parks the panel at its
 * default corner; null `size` keeps the responsive default size.
 */
export function useThemeEditorGeometry({
  open,
  isMinimized,
}: {
  open: boolean;
  isMinimized: boolean;
}) {
  // A value is a dragged spot, kept clamped so the header can always be
  // grabbed again.
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  // A value is a corner-grip resize.
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragOffsetRef = useRef<{ dx: number; dy: number } | null>(null);
  const resizeStartRef = useRef<{
    pointerX: number;
    pointerY: number;
    // Where the panel's top-left sits: the grip only moves the opposite
    // corner, so the room to grow is measured from here.
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    // A panel sized wider than the window can no longer be clamped back into
    // view by position alone -- its right edge (close, minimize, the grip)
    // stays off screen. So the size shrinks to fit first, then the position
    // is re-clamped against the new size.
    const clamp = () => {
      let clampedWidth: number | undefined;
      let clampedHeight: number | undefined;
      setSize((current) => {
        if (!current) return current;
        clampedWidth = Math.max(
          MIN_WIDTH,
          Math.min(current.width, window.innerWidth - VIEWPORT_MARGIN * 2),
        );
        clampedHeight = Math.max(
          MIN_HEIGHT,
          Math.min(current.height, window.innerHeight - VIEWPORT_MARGIN * 2),
        );
        return { width: clampedWidth, height: clampedHeight };
      });
      setPosition((current) => {
        if (!current) return current;
        const clamped = clampPanelPosition(panelRef.current, current.x, current.y, clampedWidth);
        // Dragging may park the panel with only its header showing, but a
        // window resize should pull the whole thing back into view when it
        // fits -- otherwise the grip ends up below the fold. Minimized, the
        // stored height is not applied (the panel hugs its header), so the
        // rendered height is what has to fit.
        const height = isMinimized
          ? (panelRef.current?.offsetHeight ?? 0)
          : (clampedHeight ?? panelRef.current?.offsetHeight ?? 0);
        const maxY = Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);
        return { x: clamped.x, y: Math.min(clamped.y, maxY) };
      });
    };
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [isMinimized, open]);

  const handleDragPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Buttons in the header keep their own behavior.
    if (event.target instanceof Element && event.target.closest("button, input, a")) return;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragOffsetRef.current = { dx: event.clientX - rect.x, dy: event.clientY - rect.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleDragPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const offset = dragOffsetRef.current;
    if (!offset) return;
    setPosition(
      clampPanelPosition(panelRef.current, event.clientX - offset.dx, event.clientY - offset.dy),
    );
  };

  const endDrag = () => {
    dragOffsetRef.current = null;
  };

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    // The grip drags the bottom-right corner, so the top-left must hold
    // still; the default parking spot is anchored bottom-right and would
    // slide, so it converts to an explicit position first.
    if (position === null) setPosition(clampPanelPosition(panelRef.current, rect.x, rect.y));
    resizeStartRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current;
    if (!start) return;
    // Grow only into the space right of and below the panel's own corner,
    // otherwise a panel parked away from the top-left pushes its far edges
    // (and this grip) off screen.
    const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - VIEWPORT_MARGIN - start.left);
    const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - VIEWPORT_MARGIN - start.top);
    setSize({
      width: Math.min(Math.max(start.width + event.clientX - start.pointerX, MIN_WIDTH), maxWidth),
      height: Math.min(
        Math.max(start.height + event.clientY - start.pointerY, MIN_HEIGHT),
        maxHeight,
      ),
    });
  };

  const endResize = () => {
    resizeStartRef.current = null;
  };

  return {
    panelRef,
    position,
    size,
    dragHandlers: {
      onPointerCancel: endDrag,
      onPointerDown: handleDragPointerDown,
      onPointerMove: handleDragPointerMove,
      onPointerUp: endDrag,
    },
    resizeHandlers: {
      onPointerCancel: endResize,
      onPointerDown: handleResizePointerDown,
      onPointerMove: handleResizePointerMove,
      onPointerUp: endResize,
    },
  };
}

function clampPanelPosition(
  panel: HTMLDivElement | null,
  x: number,
  y: number,
  widthOverride?: number,
) {
  // The caller passes a width when it has just shrunk the panel: the DOM
  // still reports the old one until React commits.
  const width = widthOverride ?? panel?.offsetWidth ?? 0;
  return {
    x: Math.min(
      Math.max(x, VIEWPORT_MARGIN),
      Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN),
    ),
    // Keep at least the header on screen even when dragged far down.
    y: Math.min(Math.max(y, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, window.innerHeight - 48)),
  };
}
