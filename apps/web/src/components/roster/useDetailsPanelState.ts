import { useEffect, useState, type TransitionEvent } from "react";

// Longest width transition (duration-slow) plus slack. A hidden aside never
// fires transitionend, so the phase settles on this timer instead.
const SETTLE_FALLBACK_MS = 600;

export type DetailsPanelState = "opening" | "open" | "closing" | "closed";

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Drives the desktop details aside through opening, open, closing, and closed.
 * The in-between phases end when the aside's width transition does, so `closing`
 * keeps the card join styled and `open` means the panel has settled, which
 * fixed overlays like the browser webview wait for. `toggled` stays false until
 * the user first opens or closes it, so entrance motion skips the initial mount.
 * Pass `onTransitionEnd` to the aside.
 */
export function useDetailsPanelState(open: boolean) {
  const [lastOpen, setLastOpen] = useState(open);
  const [moving, setMoving] = useState(false);
  const [toggled, setToggled] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    setToggled(true);
    setMoving(!prefersReducedMotion());
  }
  const state: DetailsPanelState = open
    ? moving
      ? "opening"
      : "open"
    : moving
      ? "closing"
      : "closed";
  useEffect(() => {
    if (!moving) return;
    const timer = window.setTimeout(() => setMoving(false), SETTLE_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [moving, open]);
  const onTransitionEnd = (event: TransitionEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget || event.propertyName !== "width") return;
    setMoving(false);
  };
  return { state, toggled, onTransitionEnd };
}
