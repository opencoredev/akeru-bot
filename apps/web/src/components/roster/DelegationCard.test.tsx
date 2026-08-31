import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AkeruDelegationRecord,
  BotId,
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type AkeruDelegationState,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  activities: [] as OrchestrationThreadActivity[],
  cancel: vi.fn(),
  navigate: vi.fn(),
  recordChatPath: vi.fn(),
  thread: null as OrchestrationThreadShell | null,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useMemo: <T,>(factory: () => T) => factory() };
});
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => EnvironmentId.make("environment-1"),
}));
vi.mock("../../state/entities", () => ({
  useThreadActivities: () => mocks.activities,
  useThreadShell: () => mocks.thread,
}));
vi.mock("../../state/orchestration", () => ({
  orchestrationEnvironment: { cancelDelegation: Symbol("cancelDelegation") },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.cancel }));
vi.mock("./rosterStore", () => ({
  useRosterStore: { getState: () => ({ recordChatPath: mocks.recordChatPath }) },
}));

import { DelegationCard, delegationUsageTokens } from "./DelegationCard";
import { visitElements } from "../../test/reactElementTree";
import type { Bot } from "./types";

const decodeDelegationRecord = Schema.decodeUnknownSync(AkeruDelegationRecord);

const childBot: Bot = {
  id: "bot-child",
  name: "Mori",
  title: "Researcher",
  label: null,
  description: null,
  disabledMcpServerIds: [],
  avatar: { kind: "dither", seed: "mori" },
  engine: null,
  sandbox: "local",
  runtimeMode: "approval-required",
  usageCap: null,
  voiceEnabled: false,
  groupId: null,
  pinned: false,
  archivedAt: null,
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
};

const childThread = {
  id: ThreadId.make("thread-child"),
  projectId: ProjectId.make("project-1"),
  botId: BotId.make("bot-child"),
  groupId: null,
  respondingBotId: BotId.make("bot-child"),
  title: "Delegated research",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-08-31T00:00:10.000Z",
  updatedAt: "2026-08-31T00:01:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
} satisfies OrchestrationThreadShell;

function delegation(state: AkeruDelegationState) {
  return decodeDelegationRecord({
    delegationId: `delegation-${state}`,
    parentDelegationId: null,
    parentBotId: "bot-parent",
    childBotId: "bot-child",
    parentThreadId: "thread-parent",
    childThreadId: state === "queued" ? null : "thread-child",
    parentTurnId: "turn-parent",
    childTurnId: state === "queued" ? null : "turn-child",
    ancestorBotIds: ["bot-parent"],
    depth: 1,
    task: "Compare the release options.",
    expectedResult: "A short comparison.",
    deadline: null,
    access: {
      allowedToolIds: ["Read"],
      memoryScopes: ["project"],
      sandbox: "local",
      runtimeMode: "approval-required",
      hasUserComputer: false,
      enabledMcpServerIds: [],
      disabledMcpServerIds: [],
      approvalCeiling: "none",
    },
    state,
    billedBotId: "bot-child",
    result:
      state === "completed"
        ? {
            summary: "Release comparison complete.",
            childThreadId: "thread-child",
            childTurnId: "turn-child",
          }
        : null,
    failure:
      state === "failed" ? { failureCode: "child_failed", message: "The provider stopped." } : null,
    keep: false,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:01:00.000Z",
    startedAt: state === "queued" ? null : "2026-08-31T00:00:10.000Z",
    completedAt: ["failed", "canceled", "completed"].includes(state)
      ? "2026-08-31T00:01:00.000Z"
      : null,
  });
}

function usage(turnId: string, totalProcessedTokens: number): OrchestrationThreadActivity {
  return {
    id: EventId.make(`usage-${turnId}`),
    tone: "info",
    kind: "context-window.updated",
    summary: "Context window updated",
    payload: { usedTokens: totalProcessedTokens, totalProcessedTokens },
    turnId: TurnId.make(turnId),
    createdAt: "2026-08-31T00:00:40.000Z",
  };
}

function renderCard(state: AkeruDelegationState, bot: Bot | null = childBot) {
  return renderToStaticMarkup(<DelegationCard delegation={delegation(state)} childBot={bot} />);
}

function cardElement(state: AkeruDelegationState, bot: Bot | null = childBot) {
  return DelegationCard({ delegation: delegation(state), childBot: bot }) as ReactElement<
    Record<string, unknown>
  >;
}

describe("DelegationCard", () => {
  beforeEach(() => {
    mocks.activities = [usage("other-turn", 99_999), usage("turn-child", 1_234)];
    mocks.thread = childThread;
    mocks.cancel.mockReset().mockResolvedValue({ _tag: "Success", value: { sequence: 1 } });
    mocks.navigate.mockReset().mockResolvedValue(undefined);
    mocks.recordChatPath.mockReset();
  });

  it.each(["queued", "running", "blocked", "failed", "canceled", "completed"] as const)(
    "shows the exact %s state",
    (state) => {
      const markup = renderCard(state);
      expect(markup).toContain(`aria-live="polite">${state}</span>`);
    },
  );

  it("shows result and failure text without mixing them", () => {
    const complete = renderCard("completed");
    expect(complete).toContain("Release comparison complete.");
    expect(complete).not.toContain("The provider stopped.");

    const failed = renderCard("failed");
    expect(failed).toContain("The provider stopped.");
    expect(failed).not.toContain("Release comparison complete.");
  });

  it("uses only the delegated child turn usage", () => {
    expect(delegationUsageTokens(delegation("completed"), mocks.activities)).toBe(1_234);
    expect(delegationUsageTokens(delegation("queued"), mocks.activities)).toBeNull();
    const markup = renderCard("completed");
    expect(markup).toContain('aria-label="1,234 tokens billed to Mori"');
    expect(markup).not.toContain("100K");
  });

  it("cancels through the delegation command with keep disabled", async () => {
    const cancel = visitElements(
      cardElement("running"),
      (element) => element.props["aria-label"] === "Cancel delegation to Mori",
    );
    (cancel?.props.onClick as (() => void) | undefined)?.();
    await Promise.resolve();
    expect(mocks.cancel).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("environment-1"),
      input: { delegationId: delegation("running").delegationId, keep: false },
    });
  });

  it("opens the child through roster thread navigation", () => {
    const open = visitElements(
      cardElement("running"),
      (element) => element.props["aria-label"] === "Open Mori thread",
    );
    (open?.props.onClick as (() => void) | undefined)?.();
    expect(mocks.recordChatPath).toHaveBeenCalledWith("bot-child", "/environment-1/thread-child");
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/bots/$botId",
      params: { botId: "bot-child" },
    });
  });

  it("handles a missing child without enabling a false route", () => {
    mocks.thread = null;
    const markup = renderCard("running", null);
    expect(markup).toContain("Unknown bot");
    expect(markup).toContain("Usage unavailable");
    expect(markup).toContain('aria-label="Open Unknown bot thread" disabled=""');
  });

  it("names both actions for assistive technology", () => {
    const markup = renderCard("running");
    expect(markup).toContain('aria-label="Cancel delegation to Mori"');
    expect(markup).toContain('aria-label="Open Mori thread"');
  });
});
