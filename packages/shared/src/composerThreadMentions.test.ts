import { describe, expect, it } from "vite-plus/test";

import {
  appendComposerMentionContext,
  buildThreadMentionExcerpt,
  isHiddenComposerThread,
  rankComposerThreadMentions,
  THREAD_MENTION_MAX_CHARS,
  THREAD_MENTION_MAX_THREADS,
  THREAD_MENTION_PICKER_LIMIT,
} from "./composerThreadMentions.ts";

const thread = (
  id: string,
  overrides: Partial<{
    projectId: string;
    title: string;
    archivedAt: string | null;
    updatedAt: string;
  }> = {},
) => ({
  id,
  projectId: overrides.projectId ?? "project-a",
  title: overrides.title ?? `Chat ${id}`,
  archivedAt: overrides.archivedAt ?? null,
  updatedAt: overrides.updatedAt ?? "2026-09-01T00:00:00.000Z",
});

describe("isHiddenComposerThread", () => {
  it("hides archived, deleted, and delegation bot-work chats", () => {
    expect(isHiddenComposerThread(thread("a"))).toBe(false);
    expect(isHiddenComposerThread(thread("a", { archivedAt: "2026-09-02T00:00:00.000Z" }))).toBe(
      true,
    );
    expect(isHiddenComposerThread(thread("delegation-thread-123"))).toBe(true);
    expect(
      isHiddenComposerThread({
        id: "a",
        archivedAt: null,
        deletedAt: "2026-09-02T00:00:00.000Z",
      }),
    ).toBe(true);
  });
});

describe("rankComposerThreadMentions", () => {
  it("drops hidden chats and the current chat", () => {
    const ranked = rankComposerThreadMentions(
      [
        thread("current"),
        thread("visible"),
        thread("archived", { archivedAt: "2026-09-02T00:00:00.000Z" }),
        thread("delegation-thread-1"),
      ],
      { query: "", currentThreadId: "current", currentProjectId: "project-a" },
    );
    expect(ranked.map((entry) => entry.id)).toEqual(["visible"]);
  });

  it("puts the current project first, then recency, and matches titles or search hits", () => {
    const ranked = rankComposerThreadMentions(
      [
        thread("other-new", {
          projectId: "project-b",
          title: "Release notes",
          updatedAt: "2026-09-09T00:00:00.000Z",
        }),
        thread("local-old", { title: "Release plan", updatedAt: "2026-09-01T00:00:00.000Z" }),
        thread("local-new", { title: "Release blockers", updatedAt: "2026-09-05T00:00:00.000Z" }),
        thread("content-hit", { title: "Something else" }),
        thread("miss", { title: "Unrelated" }),
      ],
      {
        query: "release",
        currentThreadId: null,
        currentProjectId: "project-a",
        matchedIds: new Set(["content-hit"]),
      },
    );
    expect(ranked.map((entry) => entry.id)).toEqual([
      "local-new",
      "local-old",
      "content-hit",
      "other-new",
    ]);
  });

  it("caps picker rows", () => {
    const many = Array.from({ length: 20 }, (_, index) => thread(`t${index}`));
    expect(
      rankComposerThreadMentions(many, {
        query: "",
        currentThreadId: null,
        currentProjectId: null,
      }),
    ).toHaveLength(THREAD_MENTION_PICKER_LIMIT);
  });
});

describe("buildThreadMentionExcerpt", () => {
  it("keeps the newest messages within the character budget", () => {
    const messages = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `message ${index} ${"x".repeat(900)}`,
    }));
    const excerpt = buildThreadMentionExcerpt({ id: "t1", title: "Plan", messages });
    const body = excerpt.split("\n").slice(1, -1).join("\n");
    expect(body.length).toBeLessThanOrEqual(THREAD_MENTION_MAX_CHARS);
    expect(excerpt).toContain("message 29");
    expect(excerpt).not.toContain("message 0 ");
  });

  it("skips system messages, labels speakers, and escapes the title", () => {
    const excerpt = buildThreadMentionExcerpt({
      id: "t1",
      title: 'Say "hi"',
      messages: [
        { role: "system", text: "hidden" },
        { role: "user", text: "Question" },
        { role: "assistant", text: "Answer" },
      ],
    });
    expect(excerpt).toBe(
      '<chat_context id="t1" title="Say &quot;hi&quot;">\nUser: Question\nBot: Answer\n</chat_context>',
    );
  });
});

describe("appendComposerMentionContext", () => {
  it("returns the prompt unchanged without mentions", () => {
    expect(appendComposerMentionContext("hello", { browser: null, threads: [] })).toBe("hello");
  });

  it("adds browser guidance for each gate state", () => {
    expect(appendComposerMentionContext("go", { browser: "enabled", threads: [] })).toContain(
      "preview browser tools",
    );
    expect(appendComposerMentionContext("go", { browser: "disabled", threads: [] })).toContain(
      "turned off in Settings",
    );
  });

  it("expands at most the thread budget", () => {
    const threads = Array.from({ length: 5 }, (_, index) => ({
      id: `t${index}`,
      title: `Chat ${index}`,
      messages: [{ role: "user" as const, text: "hi" }],
    }));
    const result = appendComposerMentionContext("see", { browser: null, threads });
    expect(result.match(/<chat_context /g)).toHaveLength(THREAD_MENTION_MAX_THREADS);
  });
});
