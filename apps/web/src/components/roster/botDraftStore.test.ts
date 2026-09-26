import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { clearBotDraft, flushBotDrafts, readBotDraft, writeBotDraft } from "./botDraftStore";

const DRAFTS = "akeru:bot-drafts:v1";
const VERSIONS = "akeru:bot-drafts:v1:versions";
const memory = new Map<string, string>();

beforeEach(() => {
  memory.clear();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, value);
      },
      removeItem: (key: string) => {
        memory.delete(key);
      },
      clear: () => memory.clear(),
    },
  });
});

afterEach(() => {
  flushBotDrafts();
  vi.useRealTimers();
  memory.clear();
});

describe("botDraftStore", () => {
  it("restores a typed draft after a simulated restart", () => {
    writeBotDraft("bot-1", "yo what tool calls u got?");
    expect(readBotDraft("bot-1")).toBe("yo what tool calls u got?");
  });

  it("clears a draft after send", () => {
    writeBotDraft("bot-1", "half a sentence");
    clearBotDraft("bot-1");
    expect(readBotDraft("bot-1")).toBe("");
  });

  it("keeps drafts for other bots", () => {
    writeBotDraft("bot-1", "one");
    writeBotDraft("bot-2", "two");
    clearBotDraft("bot-1");
    expect(readBotDraft("bot-2")).toBe("two");
  });

  it("keeps keystrokes in memory and persists once typing pauses", () => {
    vi.useFakeTimers();
    writeBotDraft("bot-1", "h");
    writeBotDraft("bot-1", "he");
    writeBotDraft("bot-1", "hey");
    expect(memory.size).toBe(0);
    expect(readBotDraft("bot-1")).toBe("hey");
    vi.advanceTimersByTime(500);
    expect(JSON.parse(memory.get("akeru:bot-drafts:v1") ?? "{}")).toEqual({ "bot-1": "hey" });
  });

  it("flushes on demand and keeps drafts another tab stored", () => {
    memory.set("akeru:bot-drafts:v1", JSON.stringify({ "bot-2": "from another tab" }));
    writeBotDraft("bot-1", "mine");
    flushBotDrafts();
    expect(JSON.parse(memory.get("akeru:bot-drafts:v1") ?? "{}")).toEqual({
      "bot-1": "mine",
      "bot-2": "from another tab",
    });
  });

  it("does not restore a draft another tab cleared after a pending edit", () => {
    vi.useFakeTimers();
    memory.set(DRAFTS, JSON.stringify({ "bot-1": "hello", "bot-2": "other" }));
    memory.set(VERSIONS, JSON.stringify({ seq: 2, versions: { "bot-1": 1, "bot-2": 2 } }));
    writeBotDraft("bot-1", "hello there");
    writeBotDraft("bot-2", "other bot edit");
    // Another tab sends bot-1's draft and clears it before this tab flushes.
    memory.set(DRAFTS, JSON.stringify({ "bot-2": "other" }));
    memory.set(VERSIONS, JSON.stringify({ seq: 2, versions: { "bot-2": 2 } }));
    vi.advanceTimersByTime(500);
    expect(JSON.parse(memory.get(DRAFTS) ?? "{}")).toEqual({ "bot-2": "other bot edit" });
  });

  it("keeps a local edit typed after another tab's write", () => {
    vi.useFakeTimers();
    // Another tab already wrote; its storage event may not have arrived yet.
    memory.set(DRAFTS, JSON.stringify({ "bot-1": "remote older draft" }));
    memory.set(VERSIONS, JSON.stringify({ seq: 7, versions: { "bot-1": 7 } }));
    writeBotDraft("bot-1", "my newer local edit");
    vi.advanceTimersByTime(500);
    expect(JSON.parse(memory.get(DRAFTS) ?? "{}")).toEqual({ "bot-1": "my newer local edit" });
    expect(JSON.parse(memory.get(VERSIONS) ?? "{}")).toEqual({ seq: 8, versions: { "bot-1": 8 } });
  });

  it("clears a draft this tab saved earlier", () => {
    writeBotDraft("bot-1", "sent prompt");
    flushBotDrafts();
    clearBotDraft("bot-1");
    expect(JSON.parse(memory.get(DRAFTS) ?? "{}")).toEqual({});
    expect(readBotDraft("bot-1")).toBe("");
  });
});
