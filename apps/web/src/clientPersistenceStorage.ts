import { ClientSettingsSchema, type ClientSettings } from "@t3tools/contracts";

import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

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

  try {
    return (
      getLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, ClientSettingsSchema) ??
      getLocalStorageItem(LEGACY_CLIENT_SETTINGS_STORAGE_KEY, ClientSettingsSchema)
    );
  } catch (error) {
    console.error("Could not read persisted client settings.", error);
    return null;
  }
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
