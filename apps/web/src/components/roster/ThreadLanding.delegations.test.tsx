import type { ReactElement } from "react";
import {
  AkeruDelegationRecord,
  ApprovalRequestId,
  BotId,
  EnvironmentId,
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationMessage,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";
import type { Bot, Group } from "./types";
import type { PendingUserInput } from "../../session-logic";

const mocks = vi.hoisted(() => ({
  providersAtom: Symbol("providers"),
  snapshotAtom: Symbol("snapshot"),
  peopleAtom: Symbol("people"),
  snapshot: null as OrchestrationShellSnapshot | null,
  bots: [] as Bot[],
  groups: [] as Group[],
  activities: [] as OrchestrationThreadActivity[],
  messages: [] as OrchestrationMessage[],
  pendingUserInputs: [] as PendingUserInput[],
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: () => undefined,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === mocks.snapshotAtom
      ? mocks.snapshot
      : atom === mocks.peopleAtom
        ? { current: null, host: null }
        : [],
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({ usePrimarySettings: () => ({}) }));
vi.mock("../../modelSelection", () => ({
  getCustomModelOptionsByInstance: () => new Map(),
  resolveAppModelSelectionState: () => null,
}));
vi.mock("../../providerInstances", () => ({
  applyProviderInstanceSettings: () => [],
  deriveProviderInstanceEntries: () => [],
  sortProviderInstanceEntries: () => [],
}));
vi.mock("../../state/bots", () => ({
  botEnvironment: { update: Symbol("update"), channels: { send: Symbol("send") } },
  environmentPeopleAtom: () => mocks.peopleAtom,
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => EnvironmentId.make("environment-1"),
}));
vi.mock("../../state/entities", () => ({
  useThreadActivities: () => mocks.activities,
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: { inbox: [] } }) }));
vi.mock("../../state/server", () => ({
  primaryServerProvidersAtom: mocks.providersAtom,
  serverEnvironment: { subscriptionAuth: () => null },
}));
vi.mock("../../state/session", () => ({
  useEnvironmentSessionState: () => ({ data: null, isPending: false }),
}));
vi.mock("../../state/shell", () => ({ environmentSnapshotAtom: () => mocks.snapshotAtom }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../settingsDialogStore", () => ({ openSettings: vi.fn() }));
vi.mock("../voice/VoiceCall", () => ({
  BotVoiceCallButton: () => null,
  useVoiceCall: () => ({ activeCall: null, startingBotId: null }),
}));
vi.mock("./botEngineSelection", () => ({ resolveStickyBotEngine: () => null }));
vi.mock("./botPresence", () => ({
  useBotPresence: () => "idle",
  useGroupPresence: () => "idle",
}));
vi.mock("./rosterStore", () => {
  const useRosterStore = (selector: (state: unknown) => unknown) =>
    selector({ bots: mocks.bots, groups: mocks.groups });
  useRosterStore.getState = () => ({ selectBot: vi.fn() });
  return { useRosterStore };
});
vi.mock("./useBotThreadRuntime", () => ({
  useBotThreadRuntime: () => ({
    sending: false,
    respondingRequestIds: [],
    pendingUserInputs: mocks.pendingUserInputs,
    pendingUserInputAnswers: {},
    pendingUserInputQuestionIndex: 0,
    selectPendingUserInputOption: vi.fn(),
    advancePendingUserInput: vi.fn(),
    messages: mocks.messages,
    error: null,
    latestTurn: null,
    defaultProject: null,
    botReady: true,
    bootstrapped: true,
    linkedThreadRef: {
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-parent"),
    },
    send: vi.fn(),
  }),
}));
vi.mock("./useGroupThreadRuntime", () => ({
  useGroupThreadRuntime: () => ({
    sending: false,
    messages: [],
    error: null,
    defaultProject: null,
    groupReady: true,
    bootstrapped: true,
    respondingBotId: "bot-parent",
    linkedThreadRef: {
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-parent"),
    },
    send: vi.fn(),
  }),
}));

import { BotThreadLanding } from "./BotThreadLanding";
import { ComposerPendingUserInputPanel } from "../chat/ComposerPendingUserInputPanel";
import { PluginSearchResultCard } from "../chat/PluginSearchResultCard";
import { DelegationCard } from "./DelegationCard";
import { GroupThreadLanding } from "./GroupThreadLanding";

const decodeDelegation = Schema.decodeUnknownSync(AkeruDelegationRecord);
const parentBot: Bot = {
  id: "bot-parent",
  name: "Akeru",
  title: "Boss",
  label: null,
  description: null,
  disabledMcpServerIds: [],
  avatar: { kind: "dither", seed: "parent" },
  engine: null,
  sandbox: "local",
  runtimeMode: "approval-required",
  usageCap: null,
  voiceEnabled: false,
  groupId: "group-1",
  pinned: false,
  archivedAt: null,
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
};
const childBot: Bot = { ...parentBot, id: "bot-child", name: "Mori", title: "Researcher" };
const group: Group = {
  id: "group-1",
  name: "Research",
  bossBotId: parentBot.id,
  members: [
    { kind: "bot", botId: BotId.make(parentBot.id), role: "boss" },
    { kind: "bot", botId: BotId.make(childBot.id), role: "specialist" },
  ],
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
};

function delegation(id: string, parentThreadId: string) {
  return decodeDelegation({
    delegationId: id,
    parentDelegationId: null,
    parentBotId: BotId.make(parentBot.id),
    childBotId: BotId.make(childBot.id),
    parentThreadId,
    childThreadId: null,
    parentTurnId: "turn-parent",
    childTurnId: null,
    ancestorBotIds: [BotId.make(parentBot.id)],
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
    state: "queued",
    billedBotId: BotId.make(childBot.id),
    result: null,
    failure: null,
    keep: false,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
  });
}

describe("thread landing delegations", () => {
  beforeEach(() => {
    hooks.reset();
    mocks.bots = [parentBot, childBot];
    mocks.groups = [group];
    mocks.activities = [];
    mocks.messages = [];
    mocks.pendingUserInputs = [];
    mocks.snapshot = {
      snapshotSequence: 1,
      bots: [],
      groups: [],
      delegations: [delegation("matching", "thread-parent"), delegation("other", "thread-other")],
      projects: [],
      threads: [],
      updatedAt: "2026-08-31T00:00:00.000Z",
    };
  });

  it.each([
    ["bot", () => BotThreadLanding({ botId: parentBot.id })],
    ["group", () => GroupThreadLanding({ groupId: group.id })],
  ])("renders the shared card for the matching %s thread delegation", (_kind, render) => {
    hooks.beginRender();
    const card = visitElements(
      render(),
      (element) => element.type === DelegationCard,
    ) as ReactElement<Parameters<typeof DelegationCard>[0]> | null;

    expect(card?.props.delegation.delegationId).toBe("matching");
    expect(card?.props.childBot).toBe(childBot);
  });

  it("renders plugin recommendations inside the bot conversation", () => {
    const turnId = TurnId.make("turn-plugins");
    const timestamp = "2026-09-02T20:00:00.000Z";
    mocks.messages = [
      {
        id: MessageId.make("message-user"),
        role: "user",
        text: "Can you connect my email?",
        turnId,
        streaming: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: MessageId.make("message-assistant"),
        role: "assistant",
        text: "I found Gmail.",
        turnId,
        respondingBotId: BotId.make(parentBot.id),
        streaming: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ];
    mocks.activities = [
      {
        id: EventId.make("activity-plugin-search"),
        tone: "tool",
        kind: "tool.completed",
        summary: "SearchPlugins",
        turnId,
        createdAt: timestamp,
        payload: {
          itemType: "dynamic_tool_call",
          title: "SearchPlugins",
          data: {
            result: {
              kind: "plugin-search-results",
              query: "email",
              total: 1,
              sources: { directory: "available", composio: "available" },
              recommendations: [
                {
                  id: "composio:gmail",
                  source: "composio",
                  name: "Gmail",
                  description: "Read and send email.",
                  action: "connect",
                  logoUrl: "https://logos.composio.dev/api/gmail",
                },
              ],
            },
          },
        },
      },
    ];

    hooks.beginRender();
    const card = visitElements(
      BotThreadLanding({ botId: parentBot.id }),
      (element) => element.type === PluginSearchResultCard,
    ) as ReactElement<Parameters<typeof PluginSearchResultCard>[0]> | null;

    expect(card?.props.result.query).toBe("email");
    expect(card?.props.result.recommendations[0]?.name).toBe("Gmail");
  });

  it("renders provider questions inside the bot conversation", () => {
    mocks.pendingUserInputs = [
      {
        requestId: ApprovalRequestId.make("question-request"),
        createdAt: "2026-09-02T20:00:00.000Z",
        questions: [
          {
            id: "snack",
            header: "Question",
            question: "If you had to pick a snack right now, which one?",
            options: [
              { label: "Chips", description: "Chips" },
              { label: "Fruit", description: "Fruit" },
              { label: "Chocolate", description: "Chocolate" },
            ],
            multiSelect: false,
          },
        ],
      },
    ];

    hooks.beginRender();
    const card = visitElements(
      BotThreadLanding({ botId: parentBot.id }),
      (element) => element.type === ComposerPendingUserInputPanel,
    ) as ReactElement<Parameters<typeof ComposerPendingUserInputPanel>[0]> | null;

    expect(card?.props.pendingUserInputs[0]?.questions[0]?.question).toBe(
      "If you had to pick a snack right now, which one?",
    );
  });
});
