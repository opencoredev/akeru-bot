/**
 * True when running inside the Electron preload bridge, false in a regular browser.
 * The preload script sets window.desktopBridge via contextBridge before any web-app
 * code executes, so this is reliable at module load time.
 *
 * DEV-only `?akeru-force-desktop=1` lets screenshot captures exercise desktop-gated
 * first-run UI (overlay without capture mode, first-chat chips) without a packaged
 * Electron shell. Production builds ignore the query.
 */
function readDevDesktopCapture(): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") return false;

  try {
    return new URLSearchParams(window.location.search).get("akeru-force-desktop") === "1";
  } catch {
    return false;
  }
}

export const isElectron =
  typeof window !== "undefined" &&
  (window.desktopBridge !== undefined || readDevDesktopCapture());
