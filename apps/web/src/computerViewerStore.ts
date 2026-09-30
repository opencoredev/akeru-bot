import type { BotEngine, BotSandbox, ScopedThreadRef } from "@akeru/contracts";
import { create } from "zustand";

/** The one computer viewer on screen. Every entry point opens the same thread's computer. */
export interface ComputerViewerTarget {
  readonly threadRef: ScopedThreadRef;
  readonly botName: string;
  /** The bot's workspace and engine explain why a computer is unavailable. */
  readonly sandbox: BotSandbox | null;
  readonly engine: BotEngine | null;
}

interface ComputerViewerStoreState {
  readonly target: ComputerViewerTarget | null;
}

export const useComputerViewerStore = create<ComputerViewerStoreState>(() => ({ target: null }));

export function openComputerViewer(target: ComputerViewerTarget): void {
  useComputerViewerStore.setState({ target });
}

export function closeComputerViewer(): void {
  useComputerViewerStore.setState({ target: null });
}
