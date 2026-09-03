import { create } from "zustand";

interface PluginsDialogState {
  readonly open: boolean;
  readonly requestedQuery: string | null;
  readonly openPlugins: (query?: string) => void;
  readonly closePlugins: () => void;
}

export const usePluginsDialogStore = create<PluginsDialogState>((set) => ({
  open: false,
  requestedQuery: null,
  openPlugins: (query) => set({ open: true, requestedQuery: query?.trim() || null }),
  closePlugins: () => set({ open: false, requestedQuery: null }),
}));

export function openPlugins(query?: string): void {
  usePluginsDialogStore.getState().openPlugins(query);
}

export function closePlugins(): void {
  usePluginsDialogStore.getState().closePlugins();
}

export function isLegacyPluginsPath(pathname: string): boolean {
  return pathname.replace(/^\/settings\/?/, "").split("/")[0] === "plugins";
}
