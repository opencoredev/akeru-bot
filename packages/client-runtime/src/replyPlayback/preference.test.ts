import { describe, expect, it, vi } from "vite-plus/test";
import { createReplyReadoutPreference } from "./preference.ts";
import { AUTOMATIC_READOUT_STORAGE_KEY } from "./automaticReadout.ts";

describe("client-local readout preference", () => {
  it("defaults off, loads opt-in and saves only a boolean", async () => {
    const storage = { getItem: vi.fn(async () => "true"), setItem: vi.fn(async () => {}) };
    const disabled = vi.fn();
    const preference = createReplyReadoutPreference(storage, disabled);
    expect(preference.getSnapshot().enabled).toBe(false);
    await preference.load();
    expect(preference.getSnapshot().enabled).toBe(true);
    await preference.setEnabled(false);
    expect(disabled).toHaveBeenCalledOnce();
    expect(storage.setItem).toHaveBeenCalledWith(AUTOMATIC_READOUT_STORAGE_KEY, "false");
  });
  it("does not let a delayed load overwrite explicit user choice", async () => {
    let resolve!: (value: string) => void;
    const value = new Promise<string>((done) => {
      resolve = done;
    });
    const preference = createReplyReadoutPreference(
      { getItem: () => value, setItem: async () => {} },
      () => {},
    );
    const loading = preference.load();
    await preference.setEnabled(false);
    resolve("true");
    await loading;
    expect(preference.getSnapshot().enabled).toBe(false);
  });
  it("serializes rapid preference changes", async () => {
    const values: string[] = [];
    const preference = createReplyReadoutPreference(
      {
        getItem: async () => null,
        setItem: async (_key, value) => {
          values.push(value);
        },
      },
      () => {},
    );
    const first = preference.setEnabled(true);
    const second = preference.setEnabled(false);
    await Promise.all([first, second]);
    expect(values).toEqual(["true", "false"]);
    expect(preference.getSnapshot().enabled).toBe(false);
  });
  it("reports unavailable storage without logging errors or blocking the local choice", async () => {
    const preference = createReplyReadoutPreference(
      {
        getItem: async () => {
          throw new Error("private");
        },
        setItem: async () => {
          throw new Error("private");
        },
      },
      () => {},
    );
    await preference.load();
    expect(preference.getSnapshot()).toEqual({ enabled: false, persistenceError: true });
    await preference.setEnabled(true);
    expect(preference.getSnapshot()).toEqual({ enabled: true, persistenceError: true });
  });
});
