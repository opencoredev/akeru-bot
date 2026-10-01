import type * as Electron from "electron";

/** Builds the subset of a native window exercised by an Electron adapter test. */
export function testWindow(
  input: Partial<Omit<Electron.BrowserWindow, "webContents" | "on" | "once">> & {
    on?: (...args: never[]) => void;
    once?: (...args: never[]) => void;
    webContents?: Partial<Omit<Electron.WebContents, "on">> & { on?: (...args: never[]) => void };
  },
) {
  // SAFETY: Tests inject these native-window doubles only into paths whose used methods they provide.
  return input as Electron.BrowserWindow;
}
