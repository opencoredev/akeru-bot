import type { KeybindingCommand } from "@t3tools/contracts";

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

let activeActions: ReadonlyArray<ChatPaletteAction> = [];
let activeOwner: object | null = null;

/** Returns a cleanup that only clears the registry when this owner is still the live one. */
export function registerChatPaletteActions(
  owner: object,
  actions: ReadonlyArray<ChatPaletteAction>,
): () => void {
  activeOwner = owner;
  activeActions = actions;
  return () => {
    if (activeOwner !== owner) return;
    activeOwner = null;
    activeActions = [];
  };
}

export function activeChatPaletteActions(): ReadonlyArray<ChatPaletteAction> {
  return activeActions;
}
