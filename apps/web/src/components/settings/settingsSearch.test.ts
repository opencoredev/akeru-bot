import { describe, expect, it } from "vite-plus/test";

import {
  searchableSetting,
  searchSettings,
  SETTINGS_SEARCH_ITEMS,
  type SettingsSearchItem,
} from "./settingsSearch";

const ITEMS: ReadonlyArray<SettingsSearchItem> = [
  {
    id: "word-wrap",
    title: "Word wrap",
    to: "/settings/general",
  },
  {
    id: "network-access",
    title: "Network access",
    to: "/settings/connections",
  },
  {
    id: "providers",
    title: "Providers",
    to: "/settings/providers",
  },
  {
    id: "provider-updates",
    title: "Update checks",
    to: "/settings/general",
  },
  {
    id: "automatic-updates",
    title: "Automatic updates",
    to: "/settings/general",
  },
];

describe("searchSettings", () => {
  it("finds language by English aliases and translated titles without changing its destination", () => {
    for (const query of [
      "language",
      "locale",
      "translation",
      "English",
      "system default",
      "简体中文",
      "中文",
    ]) {
      expect(searchSettings(query)).toContainEqual(
        expect.objectContaining({
          id: "language",
          to: "/settings/general",
          title: "Language",
        }),
      );
    }
    expect(
      searchSettings("langue", undefined, (title) => (title === "Language" ? "Langue" : title)),
    ).toEqual([expect.objectContaining({ id: "language", to: "/settings/general" })]);
    expect(searchableSetting("language")).toEqual({ id: "language", title: "Language" });
  });
  it("matches only setting titles", () => {
    expect(searchSettings("word", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("network", ITEMS).map((item) => item.id)).toEqual(["network-access"]);
    expect(searchSettings("connections", ITEMS)).toEqual([]);
    expect(searchSettings("claude", ITEMS)).toEqual([]);
  });

  it("matches normalized title substrings", () => {
    expect(searchSettings("  WORD   WRAP  ", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("glass").map((item) => item.id)).toEqual(["setting-glass-opacity"]);
    expect(searchSettings("local execution")[0]).toMatchObject({
      id: "local-execution",
      to: "/settings/sandbox",
    });
    expect(searchSettings("xyzzy")).toEqual([]);
  });

  it("finds bot channels by provider name", () => {
    for (const query of ["telegram", "imessage", "photon", "whatsapp"]) {
      expect(searchSettings(query).map((item) => item.id)).toContain("bot-channels");
    }
  });

  it("finds bot channels by channel repair words", () => {
    for (const query of ["Channels", "channel", "webhook", "credentials", "messaging"]) {
      expect(searchSettings(query).map((item) => item.id)).toContain("bot-channels");
    }
  });

  it("keeps catalog order for multiple title matches", () => {
    expect(searchSettings("update", ITEMS).map((item) => item.id)).toEqual([
      "provider-updates",
      "automatic-updates",
    ]);
  });

  it("returns no results for an empty query", () => {
    expect(searchSettings("   ", ITEMS)).toEqual([]);
  });

  it("hides desktop-only settings from browser search", () => {
    expect(SETTINGS_SEARCH_ITEMS.some((item) => item.id === "quit-confirmation")).toBe(true);
    expect(searchSettings("quit confirmation")).toEqual([]);
  });

  it("keeps catalog result ids unique", () => {
    const ids = SETTINGS_SEARCH_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("serves anchor props to panels from the catalog", () => {
    expect(searchableSetting("word-wrap")).toEqual({ id: "word-wrap", title: "Word wrap" });
    expect(searchableSetting("diagnostics")).toEqual({ id: "diagnostics", title: "Diagnostics" });
  });

  it("routes sandbox and browser sharing to the Sandbox page", () => {
    expect(searchSettings("sandbox and browser sharing")[0]).toMatchObject({
      id: "sandbox-browser-sharing",
      to: "/settings/sandbox",
    });
  });

  it("routes voice to the Providers page without offering a fallback model control", () => {
    expect(searchSettings("voice provider")[0]).toMatchObject({
      id: "voice-provider",
      to: "/settings/providers",
    });
    expect(searchSettings("fallback model")).not.toContainEqual(
      expect.objectContaining({ id: "text-generation-model" }),
    );
  });

  it("routes bot errors and troubleshooting to diagnostics on the Advanced page", () => {
    expect(searchSettings("errors")[0]).toMatchObject({
      id: "diagnostics",
      to: "/settings/advanced",
    });
    expect(searchSettings("diagnostics")[0]).toMatchObject({
      id: "diagnostics",
      to: "/settings/advanced",
    });
  });

  it("drops coding-agent leftovers from the index", () => {
    const ids: ReadonlyArray<string> = SETTINGS_SEARCH_ITEMS.map((item) => item.id);
    for (const id of [
      "hide-whitespace-changes",
      "skills-in-slash-menu",
      "add-project-starts-in",
      "source-control",
      "archive",
    ]) {
      expect(ids).not.toContain(id);
    }
  });

  it("routes sandbox provider settings to Sandbox settings", () => {
    expect(searchSettings("default sandbox")[0]).toMatchObject({
      id: "default-sandbox",
      to: "/settings/sandbox",
    });
  });

  it("routes analytics to Privacy settings", () => {
    expect(searchSettings("analytics")[0]).toMatchObject({
      id: "anonymous-analytics",
      to: "/settings/privacy",
    });
  });

  it("routes appearance settings to their current section", () => {
    expect(searchSettings("theme")[0]).toMatchObject({
      id: "theme",
      to: "/settings/appearance",
    });
    expect(searchSettings("word wrap")[0]).toMatchObject({
      id: "word-wrap",
      to: "/settings/appearance",
    });
    expect(searchSettings("environment identification")[0]).toMatchObject({
      id: "environment-identification",
      to: "/settings/appearance",
      targetId: "display",
    });
  });

  it("routes privacy controls to Privacy settings", () => {
    expect(searchSettings("anonymous analytics")[0]).toMatchObject({
      id: "anonymous-analytics",
      to: "/settings/privacy",
    });
    expect(searchSettings("voice calls")[0]).toMatchObject({
      id: "privacy-voice-calls",
      to: "/settings/privacy",
    });
  });

  it("routes memory controls to Privacy settings", () => {
    expect(searchSettings("shared project memory")[0]).toMatchObject({
      id: "memory-shared-project",
      to: "/settings/privacy",
    });
    expect(searchSettings("private bot memory")[0]).toMatchObject({
      id: "memory-private-bot",
      to: "/settings/privacy",
    });
  });

  it("finds image generation separately from chat providers", () => {
    expect(searchSettings("image generation")[0]).toMatchObject({
      id: "image-generation",
      to: "/settings/image-generation",
    });
    expect(searchSettings("Grok images")[0]).toMatchObject({
      id: "image-provider-grok",
      to: "/settings/image-generation",
    });
    expect(searchSettings("image fallback")[0]).toMatchObject({
      id: "image-fallback-order",
      to: "/settings/image-generation",
    });
  });
});
