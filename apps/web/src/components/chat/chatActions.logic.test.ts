import type { OrchestrationThreadShell } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type ChatActionSupport,
  hasUnseenCompletion,
  resolveChatMenuState,
  shouldForgetChatPath,
} from "./chatActions.logic";

const NOW = "2026-09-27T12:00:00.000Z";
const ALL_SUPPORTED: ChatActionSupport = {
  settlement: true,
  snooze: true,
  pinning: true,
  titleRegeneration: true,
};

function shell(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Trip plans",
    modelSelection: { instanceId: "codex", model: "gpt-6-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: "turn-1",
      state: "completed",
      requestedAt: "2026-09-27T10:00:00.000Z",
      startedAt: "2026-09-27T10:00:01.000Z",
      completedAt: "2026-09-27T10:01:00.000Z",
      assistantMessageId: null,
    },
    createdAt: "2026-09-27T09:00:00.000Z",
    updatedAt: "2026-09-27T10:01:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: "2026-09-27T10:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  } as OrchestrationThreadShell;
}

describe("resolveChatMenuState", () => {
  it("offers the way in for an idle chat the user has seen", () => {
    const state = resolveChatMenuState({
      shell: shell(),
      supports: ALL_SUPPORTED,
      lastVisitedAt: "2026-09-27T10:01:00.000Z",
      now: NOW,
    });

    expect(state).toMatchObject({
      isPinned: false,
      isSettled: false,
      isSnoozed: false,
      canSettle: true,
      canSnooze: true,
      canArchive: true,
      canMarkUnread: true,
      isRegeneratingTitle: false,
    });
  });

  it("reports each reverse state so the menu can offer the way out", () => {
    const state = resolveChatMenuState({
      shell: shell({
        pinnedAt: "2026-09-27T11:00:00.000Z",
        settledOverride: "settled",
        settledAt: "2026-09-27T11:00:00.000Z",
        snoozedUntil: "2026-09-28T09:00:00.000Z",
        snoozedAt: "2026-09-27T11:00:00.000Z",
      }),
      supports: ALL_SUPPORTED,
      lastVisitedAt: undefined,
      now: NOW,
    });

    expect(state.isPinned).toBe(true);
    expect(state.isSettled).toBe(true);
    expect(state.isSnoozed).toBe(true);
    expect(state.snoozedUntil).toBe("2026-09-28T09:00:00.000Z");
  });

  it("treats a snooze whose wake time passed as awake", () => {
    const state = resolveChatMenuState({
      shell: shell({ snoozedUntil: "2026-09-27T11:00:00.000Z" }),
      supports: ALL_SUPPORTED,
      lastVisitedAt: undefined,
      now: NOW,
    });

    expect(state.isSnoozed).toBe(false);
    expect(state.snoozedUntil).toBeNull();
  });

  it("blocks archive and settle while a turn runs", () => {
    const state = resolveChatMenuState({
      shell: shell({
        session: {
          threadId: "thread-1",
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: "turn-2",
          lastError: null,
          updatedAt: NOW,
        } as OrchestrationThreadShell["session"],
      }),
      supports: ALL_SUPPORTED,
      lastVisitedAt: undefined,
      now: NOW,
    });

    expect(state.canArchive).toBe(false);
    expect(state.canSettle).toBe(false);
  });

  it("does not claim settled or snoozed on a server that cannot do either", () => {
    const state = resolveChatMenuState({
      shell: shell({
        settledOverride: "settled",
        settledAt: "2026-09-27T11:00:00.000Z",
        snoozedUntil: "2026-09-28T09:00:00.000Z",
      }),
      supports: { ...ALL_SUPPORTED, settlement: false, snooze: false },
      lastVisitedAt: undefined,
      now: NOW,
    });

    expect(state.isSettled).toBe(false);
    expect(state.isSnoozed).toBe(false);
  });

  it("only offers Mark unread when there is a finished turn that is not already unread", () => {
    const unread = resolveChatMenuState({
      shell: shell(),
      supports: ALL_SUPPORTED,
      lastVisitedAt: "2026-09-27T10:00:59.999Z",
      now: NOW,
    });
    const noTurn = resolveChatMenuState({
      shell: shell({ latestTurn: null }),
      supports: ALL_SUPPORTED,
      lastVisitedAt: undefined,
      now: NOW,
    });

    expect(unread.canMarkUnread).toBe(false);
    expect(noTurn.canMarkUnread).toBe(false);
  });
});

describe("hasUnseenCompletion", () => {
  it("is unread only when a turn finished after the last visit", () => {
    expect(hasUnseenCompletion("2026-09-27T10:01:00.000Z", "2026-09-27T10:00:00.000Z")).toBe(true);
    expect(hasUnseenCompletion("2026-09-27T10:01:00.000Z", "2026-09-27T10:01:00.000Z")).toBe(false);
  });

  it("never marks a chat this browser has not shown as unread", () => {
    expect(hasUnseenCompletion("2026-09-27T10:01:00.000Z", undefined)).toBe(false);
    expect(hasUnseenCompletion(null, "2026-09-27T10:00:00.000Z")).toBe(false);
  });
});

describe("shouldForgetChatPath", () => {
  it("forgets the remembered path only when it points at the removed chat", () => {
    const removed = { environmentId: "env-1", threadId: "thread-1" };
    expect(shouldForgetChatPath("/env-1/thread-1", removed)).toBe(true);
    expect(shouldForgetChatPath("/env-1/thread-2", removed)).toBe(false);
    expect(shouldForgetChatPath(undefined, removed)).toBe(false);
  });
});
