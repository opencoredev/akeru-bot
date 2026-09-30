import type { KeybindingCommand } from "@akeru/contracts";
import { useSyncExternalStore } from "react";

/**
 * One chat action the command palette can run on the open chat. The chat
 * header's menu publishes its entries here, so the palette offers the same
 * actions without knowing which chat surface is mounted.
 */
export interface ChatPaletteAction {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly searchTerms: ReadonlyArray<string>;
  readonly shortcutCommand?: KeybindingCommand;
  readonly run: () => Promise<void> | void;
}

const NO_ACTIONS: ReadonlyArray<ChatPaletteAction> = [];
let activeActions: ReadonlyArray<ChatPaletteAction> = NO_ACTIONS;
let activeOwner: object | null = null;
const listeners = new Set<() => void>();

function publish(actions: ReadonlyArray<ChatPaletteAction>): void {
  activeActions = actions;
  for (const listener of listeners) listener();
}

/** Returns a cleanup that only clears the registry when this owner is still the live one. */
export function registerChatPaletteActions(
  owner: object,
  actions: ReadonlyArray<ChatPaletteAction>,
): () => void {
  activeOwner = owner;
  publish(actions);
  return () => {
    if (activeOwner !== owner) return;
    activeOwner = null;
    publish(NO_ACTIONS);
  };
}

export function activeChatPaletteActions(): ReadonlyArray<ChatPaletteAction> {
  return activeActions;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The open chat's actions, re-read whenever the chat header publishes new ones. */
export function useActiveChatPaletteActions(): ReadonlyArray<ChatPaletteAction> {
  return useSyncExternalStore(subscribe, activeChatPaletteActions, () => NO_ACTIONS);
}
