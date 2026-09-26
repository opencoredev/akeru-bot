import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  clearBotDraft,
  readBotDraft,
  resetBotDraftMigrationForTests,
  writeBotDraft,
} from "./botDraftStore";

const memory = new Map<string, string>();

beforeEach(() => {
  memory.clear();
  resetBotDraftMigrationForTests();
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

describe("botDraftStore", () => {
  it("restores a typed draft after a simulated restart", () => {
    writeBotDraft("bot-1", "yo what tool calls u got?");
    resetBotDraftMigrationForTests();
    expect(readBotDraft("bot-1")).toBe("yo what tool calls u got?");
  });

  it("clears a draft after send", () => {
    writeBotDraft("bot-1", "half a sentence");
    clearBotDraft("bot-1");
    expect(readBotDraft("bot-1")).toBe("");
    expect(memory.size).toBe(0);
  });

  it("keeps drafts for other bots", () => {
    writeBotDraft("bot-1", "one");
    writeBotDraft("bot-2", "two");
    clearBotDraft("bot-1");
    expect(readBotDraft("bot-2")).toBe("two");
  });

  it("writes only the edited draft's key", () => {
    writeBotDraft("bot-2", "untouched");
    writeBotDraft("bot-1", "hey");
    expect([...memory.keys()].sort()).toEqual([
      "akeru:bot-draft:v2:bot-1",
      "akeru:bot-draft:v2:bot-2",
    ]);
  });

  it("moves legacy drafts to per-draft keys once", () => {
    memory.set("akeru:bot-drafts:v1", JSON.stringify({ "bot-1": "old draft", "bot-2": 3 }));
    expect(readBotDraft("bot-1")).toBe("old draft");
    expect(memory.has("akeru:bot-drafts:v1")).toBe(false);
    clearBotDraft("bot-1");
    expect(readBotDraft("bot-1")).toBe("");
  });
});
