import { ClientSettingsSchema, type ClientSettings } from "@t3tools/contracts";

import { getFirstLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

export const CLIENT_SETTINGS_STORAGE_KEY = "akeru:client-settings:v1";
// Pre-rebrand key, kept so existing installs keep their client settings.
export const LEGACY_CLIENT_SETTINGS_STORAGE_KEY = "t3code:client-settings:v1";

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

export function readBrowserClientSettings(): ClientSettings | null {
  if (!hasWindow()) {
    return null;
  }

  return getFirstLocalStorageItem(
    [CLIENT_SETTINGS_STORAGE_KEY, LEGACY_CLIENT_SETTINGS_STORAGE_KEY],
    ClientSettingsSchema,
    (error) => console.error("Could not read persisted client settings.", error),
  );
}

export function writeBrowserClientSettings(settings: ClientSettings): void {
  if (!hasWindow()) {
    return;
  }

  setLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, settings, ClientSettingsSchema);
  try {
    window.localStorage.removeItem(LEGACY_CLIENT_SETTINGS_STORAGE_KEY);
  } catch {
    // Draining the legacy key is best-effort.
  }
}
