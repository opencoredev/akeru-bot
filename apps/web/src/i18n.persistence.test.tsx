import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@akeru/contracts/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { LanguageProvider, useI18n } from "./i18n";
import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
  getClientSettings,
  useUpdateClientSettings,
} from "./hooks/useSettings";
import { CLIENT_SETTINGS_STORAGE_KEY } from "./clientPersistenceStorage";

const subscriptions = vi.hoisted(() => new Set<(listener: () => void) => () => void>());
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useSyncExternalStore: <T,>(
    subscribe: (listener: () => void) => () => void,
    getSnapshot: () => T,
  ) => {
    subscriptions.add(subscribe);
    return getSnapshot();
  },
}));

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
}

let current: ReturnType<typeof useI18n>;
let updateOther: ReturnType<typeof useUpdateClientSettings>;
const cleanups: Array<() => void> = [];
function Probe() {
  current = useI18n();
  updateOther = useUpdateClientSettings();
  return <span lang={current.locale}>{current.preference}</span>;
}
function render() {
  return renderToStaticMarkup(
    <LanguageProvider>
      <Probe />
    </LanguageProvider>,
  );
}
function subscribe() {
  for (const subscription of subscriptions) cleanups.push(subscription(() => {}));
}
function resetRenderer() {
  for (const cleanup of cleanups.splice(0)) cleanup();
  subscriptions.clear();
  __resetClientSettingsPersistenceForTests();
}

beforeEach(() => {
  resetRenderer();
  vi.stubGlobal("navigator", { languages: ["en-GB"] });
});
afterEach(() => {
  resetRenderer();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("language client settings persistence", () => {
  it("hydrates Electron language from disk after an origin reset and persists changes without replacing unrelated preferences", async () => {
    let disk: ClientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      language: "en",
      timestampFormat: "24-hour",
      environmentIdentificationMode: "none",
    };
    const bridge = {
      getClientSettings: vi.fn(async () => disk),
      setClientSettings: vi.fn(async (settings: ClientSettings) => {
        disk = settings;
      }),
    };
    const localStorage = storage();
    vi.stubGlobal(
      "window",
      Object.assign(new EventTarget(), { desktopBridge: bridge, localStorage }),
    );
    render();
    subscribe();
    await ensureClientSettingsHydrated();
    expect(render()).toContain('lang="en">en');
    expect(localStorage.getItem(CLIENT_SETTINGS_STORAGE_KEY)).toBeNull();

    const change = current.setPreference("system");
    updateOther({ timestampFormat: "12-hour" });
    await change;
    expect(disk).toMatchObject({
      language: "system",
      timestampFormat: "12-hour",
      environmentIdentificationMode: "none",
    });
    await current.setPreference("en");
    expect(disk.language).toBe("en");

    resetRenderer();
    vi.stubGlobal(
      "window",
      Object.assign(new EventTarget(), { desktopBridge: bridge, localStorage: storage() }),
    );
    render();
    subscribe();
    await ensureClientSettingsHydrated();
    expect(render()).toContain('lang="en">en');
    expect(bridge.getClientSettings).toHaveBeenCalledTimes(2);
    await current.setPreference("system");
    expect(disk).toMatchObject({
      language: "system",
      timestampFormat: "12-hour",
      environmentIdentificationMode: "none",
    });
    expect(render()).toContain('lang="en-GB">system');
    expect(bridge.setClientSettings).toHaveBeenLastCalledWith(disk);
  });

  it("waits for disk hydration before applying a language change", async () => {
    let resolveDisk!: (settings: ClientSettings) => void;
    const diskRead = new Promise<ClientSettings>((resolve) => {
      resolveDisk = resolve;
    });
    const setClientSettings = vi.fn(async (_settings: ClientSettings) => {});
    vi.stubGlobal(
      "window",
      Object.assign(new EventTarget(), {
        desktopBridge: { getClientSettings: () => diskRead, setClientSettings },
        localStorage: storage(),
      }),
    );
    render();
    const change = current.setPreference("en");
    expect(setClientSettings).not.toHaveBeenCalled();
    resolveDisk({ ...DEFAULT_CLIENT_SETTINGS, timestampFormat: "24-hour" });
    await change;
    expect(setClientSettings).toHaveBeenCalledWith(
      expect.objectContaining({ language: "en", timestampFormat: "24-hour" }),
    );
  });

  it("stores web language in the existing client settings object and refreshes system/device and cross-tab state", async () => {
    const localStorage = storage();
    const browser = Object.assign(new EventTarget(), { localStorage });
    vi.stubGlobal("window", browser);
    render();
    subscribe();
    await ensureClientSettingsHydrated();
    await current.setPreference("en");
    expect(JSON.parse(localStorage.getItem(CLIENT_SETTINGS_STORAGE_KEY)!)).toMatchObject({
      language: "en",
    });
    expect(localStorage.getItem("akeru:language")).toBeNull();
    await current.setPreference("system");
    expect(JSON.parse(localStorage.getItem(CLIENT_SETTINGS_STORAGE_KEY)!)).toMatchObject({
      language: "system",
    });
    vi.stubGlobal("navigator", { languages: ["en-AU"] });
    browser.dispatchEvent(new Event("languagechange"));
    expect(render()).toContain('lang="en-AU">system');

    localStorage.setItem(
      CLIENT_SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_CLIENT_SETTINGS, language: "en" }),
    );
    browser.dispatchEvent(
      Object.assign(new Event("storage"), { key: CLIENT_SETTINGS_STORAGE_KEY }),
    );
    await ensureClientSettingsHydrated();
    expect(render()).toContain('lang="en">en');
  });

  it("keeps a session preference when browser storage access is denied", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const browser = new EventTarget();
    Object.defineProperty(browser, "localStorage", {
      get: () => {
        throw new Error("Storage denied");
      },
    });
    vi.stubGlobal("window", browser);
    render();
    subscribe();
    await ensureClientSettingsHydrated();
    await current.setPreference("en");
    expect(getClientSettings().language).toBe("en");
    expect(render()).toContain('lang="en">en');
    await current.setPreference("system");
    expect(getClientSettings().language).toBe("system");
    expect(render()).toContain('lang="en-GB">system');
  });
});
