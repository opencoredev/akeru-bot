import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  ClientSettingsSchema,
  ClientSettingsPatch,
  ServerSettings,
  ServerSettingsRpcPatch,
} from "./settings.ts";

const decodeClient = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodePatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const encodeClient = Schema.encodeSync(ClientSettingsSchema);

describe("client-local language preference", () => {
  it("defaults existing client documents to system language", () => {
    expect(decodeClient({}).language).toBe("system");
  });

  it("round-trips a preference through the desktop client-settings document", () => {
    const settings = decodeClient({ language: "en" });
    expect(decodeClient(JSON.parse(JSON.stringify(encodeClient(settings))))).toEqual(settings);
    expect(decodePatch({ language: "system" })).toEqual({ language: "system" });
  });

  it("keeps future locale preferences recoverable without accepting malformed values", () => {
    expect(decodeClient({ language: "future-locale" }).language).toBe("future-locale");
    expect(() => decodeClient({ language: 42 })).toThrow();
  });

  it("never adds language to environment settings or their RPC patch", () => {
    expect(Object.hasOwn(ServerSettings.fields, "language")).toBe(false);
    expect(Object.hasOwn(ServerSettingsRpcPatch.fields, "language")).toBe(false);
  });
});
