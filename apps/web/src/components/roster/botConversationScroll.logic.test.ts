import { describe, expect, it } from "vite-plus/test";

import {
  isConversationAtEnd,
  didScrollAwayFromEnd,
  reduceConversationFollowState,
} from "./botConversationScroll.logic";

describe("isConversationAtEnd", () => {
  it("treats underflowing and end-aligned conversations as live", () => {
    expect(isConversationAtEnd({ scrollTop: 0, scrollHeight: 400, clientHeight: 600 })).toBe(true);
    expect(isConversationAtEnd({ scrollTop: 400, scrollHeight: 1000, clientHeight: 600 })).toBe(
      true,
    );
  });

  it("stops live follow when the user moves above the end threshold", () => {
    expect(isConversationAtEnd({ scrollTop: 300, scrollHeight: 1000, clientHeight: 600 })).toBe(
      false,
    );
    expect(isConversationAtEnd({ scrollTop: 378, scrollHeight: 1000, clientHeight: 600 })).toBe(
      true,
    );
  });
});

describe("reduceConversationFollowState", () => {
  it("does not follow streaming growth after the user scrolls away", () => {
    const state = reduceConversationFollowState(
      { followingEnd: true },
      { type: "user-navigation" },
    );

    expect(state).toEqual({ followingEnd: false });
  });

  it("stays pinned when content growth moves the end away without user input", () => {
    const state = reduceConversationFollowState(
      { followingEnd: true },
      { type: "scroll", isAtEnd: false, movedAway: false },
    );

    expect(state).toEqual({ followingEnd: true });
  });

  it("unpins when the reader scrolls toward older messages", () => {
    const state = reduceConversationFollowState(
      { followingEnd: true },
      { type: "scroll", isAtEnd: false, movedAway: true },
    );

    expect(state).toEqual({ followingEnd: false });
  });

  it("re-enables live follow when the user returns to the end", () => {
    const state = reduceConversationFollowState(
      { followingEnd: false },
      { type: "scroll", isAtEnd: true, movedAway: true },
    );

    expect(state).toEqual({ followingEnd: true });
  });

  it("keeps a smooth scroll to the end pinned while it is in flight", () => {
    const started = reduceConversationFollowState(
      { followingEnd: false },
      { type: "scroll-to-end" },
    );
    const inProgress = reduceConversationFollowState(started, {
      type: "scroll",
      isAtEnd: false,
      movedAway: false,
    });

    expect(inProgress).toEqual({ followingEnd: true });
  });
});

describe("didScrollAwayFromEnd", () => {
  const base = { scrollTop: 800, scrollHeight: 1400, clientHeight: 600 };

  it("detects the reader scrolling up while layout is unchanged", () => {
    expect(didScrollAwayFromEnd(base, { ...base, scrollTop: 500 })).toBe(true);
  });

  it("ignores scrolls caused by content or viewport size changes", () => {
    expect(didScrollAwayFromEnd(base, { ...base, scrollTop: 700, scrollHeight: 1300 })).toBe(false);
    expect(didScrollAwayFromEnd(base, { ...base, scrollTop: 700, clientHeight: 700 })).toBe(false);
  });

  it("ignores scrolling toward the end", () => {
    expect(didScrollAwayFromEnd(base, { ...base, scrollTop: 810 })).toBe(false);
  });
});
