import { describe, expect, it } from "vite-plus/test";

import { formatRosterTimestamp, isRecordableChatPath, parseChatPath } from "./roster.logic";

describe("formatRosterTimestamp", () => {
  const now = new Date("2026-08-27T15:00:00").getTime();

  it("shows a clock time today, Yesterday, then weekday, then date", () => {
    expect(formatRosterTimestamp("2026-08-27T09:30:00", "24-hour", now)).toBe("09:30");
    expect(formatRosterTimestamp("2026-08-26T09:30:00", "24-hour", now)).toBe("Yesterday");
    expect(formatRosterTimestamp("2026-08-24T09:30:00", "24-hour", now)).not.toContain(":");
    expect(formatRosterTimestamp("2026-01-02T09:30:00", "24-hour", now)).toContain("2");
  });

  it("returns empty for an invalid date", () => {
    expect(formatRosterTimestamp("nope", "24-hour", now)).toBe("");
  });
});

describe("parseChatPath", () => {
  it("parses a legacy server thread route", () => {
    expect(parseChatPath("/env-1/thread-9")).toEqual({
      kind: "thread",
      environmentId: "env-1",
      threadId: "thread-9",
    });
  });

  it("rejects non-chat routes", () => {
    expect(isRecordableChatPath("/")).toBe(false);
    expect(isRecordableChatPath("/settings/appearance")).toBe(false);
    expect(isRecordableChatPath("/projects/my-project")).toBe(false);
    expect(isRecordableChatPath("/bots/bot-akeru")).toBe(false);
    expect(isRecordableChatPath("/draft/draft-123")).toBe(false);
    expect(isRecordableChatPath("/usage")).toBe(false);
  });
});
