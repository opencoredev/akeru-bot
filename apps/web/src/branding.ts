import type { DesktopAppBranding } from "@t3tools/contracts";
import { formatAppDisplayName } from "./branding.logic";

function readInjectedDesktopAppBranding(): DesktopAppBranding | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.desktopBridge?.getAppBranding?.() ?? null;
}

const injectedDesktopAppBranding = readInjectedDesktopAppBranding();
export const APP_BASE_NAME = injectedDesktopAppBranding?.baseName ?? "Akeru Bot";
export const APP_STAGE_LABEL =
  injectedDesktopAppBranding?.stageLabel ?? (import.meta.env.DEV ? "Dev" : "Alpha");
export const APP_DISPLAY_NAME =
  injectedDesktopAppBranding?.displayName ??
  formatAppDisplayName({ baseName: APP_BASE_NAME, stageLabel: APP_STAGE_LABEL });
export const IS_PACKAGED_DESKTOP = injectedDesktopAppBranding?.isPackaged ?? false;
export const APP_VERSION = import.meta.env.APP_VERSION || "0.0.0";
