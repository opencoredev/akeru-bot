"use client";

import { Predicate } from "effect";

/**
 * Typed window-event bus for preview-panel actions. Lets the global
 * keybinding handler in `routes/_chat.tsx` reach `ChatView`'s URL-aware
 * arbitration without prop drilling or shared refs.
 */
export type PreviewAction =
  | "toggle-panel"
  | "refresh"
  | "focus-url"
  | "zoom-in"
  | "zoom-out"
  | "reset-zoom";

const EVENT_NAME = "akeru:preview-action";

export function dispatchPreviewAction(action: PreviewAction): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<PreviewAction>(EVENT_NAME, { detail: action }));
}

export function subscribePreviewAction(listener: (action: PreviewAction) => void): () => void {
  if (typeof window === "undefined") return () => {};

  const handler = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    // SAFETY: only dispatchPreviewAction emits this private event, with a PreviewAction detail.
    const detail = (event as CustomEvent<PreviewAction>).detail;

    if (Predicate.isString(detail)) listener(detail);
  };

  window.addEventListener(EVENT_NAME, handler);

  return () => window.removeEventListener(EVENT_NAME, handler);
}
