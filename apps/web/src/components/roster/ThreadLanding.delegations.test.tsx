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
  type OrchestrationLatestTurn,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";
import type { Bot, Group } from "./types";
import type { PendingApproval, PendingUserInput } from "../../session-logic";

const mocks = vi.hoisted(() => ({
  providersAtom: Symbol("providers"),
  snapshotAtom: Symbol("snapshot"),
  peopleAtom: Symbol("people"),
  snapshot: null as OrchestrationShellSnapshot | null,
  bots: [] as Bot[],
  groups: [] as Group[],
  activities: [] as OrchestrationThreadActivity[],
  messages: [] as OrchestrationMessage[],
  groupMessages: [] as OrchestrationMessage[],
  pendingUserInputs: [] as PendingUserInput[],
  groupPendingUserInputs: [] as PendingUserInput[],
  pendingApproval: null as PendingApproval | null,
  latestTurn: null as OrchestrationLatestTurn | null,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: () => undefined,
    useId: () => "test-id",
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
vi.mock("../../i18n", async () => {
  const { createTranslator } = await import("@t3tools/client-runtime/i18n");
  const translator = createTranslator("en");
  return { useI18n: () => ({ ...translator, t: translator.translate }) };
});
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
  environmentBotsAtom: () => Symbol("bots"),
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => EnvironmentId.make("environment-1"),
}));
vi.mock("./detailsPanelOpen", () => ({
  useBotDetailsOpen: () => [false, () => undefined],
  useGroupDetailsOpen: () => [false, () => undefined],
}));
vi.mock("../chat/ChatActionsMenu", () => ({
  ChatActionsMenu: () => null,
  useMarkChatVisited: () => undefined,
}));
vi.mock("../../state/entities", () => ({
  useThreadActivities: () => mocks.activities,
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: { inbox: [] } }) }));
vi.mock("../../state/server", () => ({
  primaryServerProvidersAtom: mocks.providersAtom,
  serverEnvironment: { subscriptionAuth: () => null, routineThreadRuns: () => null },
}));
vi.mock("../../state/session", () => ({
  useEnvironmentSessionState: () => ({ data: null, isPending: false }),
}));
vi.mock("../../state/shell", () => ({ environmentSnapshotAtom: () => mocks.snapshotAtom }));
vi.mock("./useServerRoster", () => ({
  useRosterLoadState: () => ({ kind: "loading" }),
  useEnableBotAutoReview: () => vi.fn(),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../settingsDialogStore", () => ({ openSettings: vi.fn() }));
vi.mock("../voice/VoiceCall", () => ({
  BotVoiceCallButton: () => null,
  useVoiceCall: () => ({ activeCall: null, startingBotId: null }),
  useOptionalVoiceCall: () => ({ activeCall: null, startingBotId: null }),
}));
vi.mock("../chat/ReplyPlaybackProvider", () => ({
  ReplyPlaybackProvider: ({ children }: { children: unknown }) => children,
  useOptionalReplyPlayback: () => null,
  useReplyPlayback: () => {
    throw new Error("Reply playback is not available in this test.");
  },
}));
vi.mock("~/lib/replyPlaybackThread", () => ({
  useReplyPlaybackThread: () => undefined,
  replyPlaybackControlProps: () => undefined,
}));
vi.mock("./useRosterPendingApproval", () => ({
  useRosterPendingApproval: () => ({
    pendingApproval: mocks.pendingApproval,
    pendingCount: mocks.pendingApproval ? 1 : 0,
    responding: false,
    responseError: null,
    respond: vi.fn(),
  }),
}));
vi.mock("./useBotEngineAvailability", () => ({
  useBotEngineAvailability: () => ({
    instanceEntries: [],
    selection: null,
    unavailability: null,
    blocked: false,
  }),
}));
vi.mock("./botPresence", () => ({
  useBotPresence: () => "idle",
  useGroupPresence: () => "idle",
}));
vi.mock("./rosterStore", () => {
  const useRosterStore = (selector: (state: unknown) => unknown) =>
    selector({ bots: mocks.bots, groups: mocks.groups, environmentId: "environment-1" });
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
    defaultProject: null,
    botReady: true,
    bootstrapped: true,
    linkedThreadRef: {
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-parent"),
    },
    latestTurn: mocks.latestTurn,
    send: vi.fn(),
  }),
}));
vi.mock("./useGroupThreadRuntime", () => ({
  useGroupThreadRuntime: () => ({
    sending: false,
    respondingRequestIds: [],
    messages: mocks.groupMessages,
    error: null,
    defaultProject: null,
    groupReady: true,
    bootstrapped: true,
    respondingBotId: "bot-parent",
    linkedThreadRef: {
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-parent"),
    },
    latestTurn: mocks.latestTurn,
    pendingUserInputs: mocks.groupPendingUserInputs,
    pendingUserInputAnswers: {},
    pendingUserInputQuestionIndex: 0,
    selectPendingUserInputOption: vi.fn(),
    advancePendingUserInput: vi.fn(),
    send: vi.fn(),
  }),
}));

import { AssistantMessageRow } from "./BotChatMessageRows";
import { BotThreadLanding } from "./BotThreadLanding";
import { BotPromptComposer } from "./BotPromptComposer";
import { ComposerPendingUserInputPanel } from "../chat/ComposerPendingUserInputPanel";
import { DelegationCard } from "./DelegationCard";
import { GroupThreadLanding } from "./GroupThreadLanding";
import { BotUserInputPrompt } from "./BotUserInputPrompt";
import { ThreadRuntimeWarningBanner } from "./ThreadRuntimeWarningBanner";

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

function delegation(
  id: string,
  parentThreadId: string,
  placement: { readonly parentTurnId?: string; readonly anchorMessageId?: string } = {},
) {
  return decodeDelegation({
    delegationId: id,
    parentDelegationId: null,
    parentBotId: BotId.make(parentBot.id),
    childBotId: BotId.make(childBot.id),
    parentThreadId,
    childThreadId: null,
    parentTurnId: placement.parentTurnId ?? "turn-parent",
    anchorMessageId: placement.anchorMessageId ?? null,
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

function message(id: string, role: "user" | "assistant", turn: string, minute: number) {
  const timestamp = `2026-09-11T12:0${minute}:00.000Z`;
  return {
    id: MessageId.make(id),
    role,
    text: `${role} ${id}`,
    turnId: TurnId.make(turn),
    ...(role === "assistant" ? { respondingBotId: BotId.make(parentBot.id) } : {}),
    streaming: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  } satisfies OrchestrationMessage;
}

// Three turns, each started by a user message and answered by the parent bot.
const THREE_TURNS = [
  message("user-1", "user", "turn-1", 1),
  message("reply-1", "assistant", "turn-1", 2),
  message("user-2", "user", "turn-2", 3),
  message("reply-2", "assistant", "turn-2", 4),
  message("user-3", "user", "turn-3", 5),
  message("reply-3", "assistant", "turn-3", 6),
];

/** Message ids and delegation ids in the order the landing renders them. */
function timelineOrder(rendered: unknown): string[] {
  const order: string[] = [];
  visitElements(rendered, (element) => {
    if (element.type === DelegationCard) {
      order.push(
        `card:${(element.props as Parameters<typeof DelegationCard>[0]).delegation.delegationId}`,
      );
      return false;
    }
    const key = element.key?.replace(/^message:/, "");
    if (key && THREE_TURNS.some((entry) => entry.id === key)) order.push(key);
    return false;
  });
  return order;
}

describe("thread landing delegations", () => {
  beforeEach(() => {
    hooks.reset();
    mocks.bots = [parentBot, childBot];
    mocks.groups = [group];
    mocks.activities = [];
    mocks.messages = [];
    mocks.groupMessages = [];
    mocks.pendingUserInputs = [];
    mocks.groupPendingUserInputs = [];
    mocks.pendingApproval = null;
    mocks.latestTurn = null;
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

  it.each([
    ["bot", () => BotThreadLanding({ botId: parentBot.id })],
    ["group", () => GroupThreadLanding({ groupId: group.id })],
  ])("places three delegations from three turns at three points in the %s chat", (kind, render) => {
    if (kind === "bot") mocks.messages = THREE_TURNS;
    else mocks.groupMessages = THREE_TURNS;
    mocks.snapshot = {
      ...mocks.snapshot!,
      delegations: [
        delegation("first", "thread-parent", { parentTurnId: "turn-1", anchorMessageId: "user-1" }),
        delegation("second", "thread-parent", {
          parentTurnId: "turn-2",
          anchorMessageId: "user-2",
        }),
        delegation("third", "thread-parent", { parentTurnId: "turn-3", anchorMessageId: "user-3" }),
      ],
    };

    hooks.beginRender();
    expect(timelineOrder(render())).toEqual([
      "user-1",
      "reply-1",
      "card:first",
      "user-2",
      "reply-2",
      "card:second",
      "user-3",
      "reply-3",
      "card:third",
    ]);
  });

  it("follows the anchor, then the parent turn, then the end of the chat", () => {
    mocks.messages = THREE_TURNS;
    mocks.snapshot = {
      ...mocks.snapshot!,
      delegations: [
        delegation("by-anchor", "thread-parent", {
          parentTurnId: "turn-gone",
          anchorMessageId: "reply-2",
        }),
        delegation("by-turn", "thread-parent", { parentTurnId: "turn-1" }),
        delegation("unplaced", "thread-parent", { parentTurnId: "turn-gone" }),
      ],
    };

    hooks.beginRender();
    expect(timelineOrder(BotThreadLanding({ botId: parentBot.id }))).toEqual([
      "user-1",
      "reply-1",
      "card:by-turn",
      "user-2",
      "reply-2",
      "card:by-anchor",
      "user-3",
      "reply-3",
      "card:unplaced",
    ]);
  });

  it("names the asking bot on group cards", () => {
    hooks.beginRender();
    const groupCard = visitElements(
      GroupThreadLanding({ groupId: group.id }),
      (element) => element.type === DelegationCard,
    ) as ReactElement<Parameters<typeof DelegationCard>[0]> | null;
    hooks.reset();
    const botCard = visitElements(
      BotThreadLanding({ botId: parentBot.id }),
      (element) => element.type === DelegationCard,
    ) as ReactElement<Parameters<typeof DelegationCard>[0]> | null;

    expect(groupCard?.props.variant).toBe("group");
    expect(groupCard?.props.parentBot).toBe(parentBot);
    expect(botCard?.props.variant).toBeUndefined();
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
    const row = visitElements(
      BotThreadLanding({ botId: parentBot.id }),
      (element) => element.type === AssistantMessageRow,
    ) as ReactElement<Parameters<typeof AssistantMessageRow>[0]> | null;
    const result = row?.props.pluginResults?.[0]?.result;

    expect(result?.query).toBe("email");
    expect(result?.recommendations[0]?.name).toBe("Gmail");
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

  it("renders pending provider questions in group threads", () => {
    mocks.groupPendingUserInputs = [
      {
        requestId: "group-question" as PendingUserInput["requestId"],
        createdAt: "2026-09-01T00:00:00.000Z",
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Which workspace should I use?",
            options: [{ label: "Current", description: "Use the current workspace." }],
            multiSelect: false,
          },
        ],
      },
    ];

    hooks.beginRender();
    const prompt = visitElements(
      GroupThreadLanding({ groupId: group.id }),
      (element) => element.type === BotUserInputPrompt,
    ) as ReactElement<Parameters<typeof BotUserInputPrompt>[0]> | null;

    expect(prompt?.props.pendingUserInputs).toEqual(mocks.groupPendingUserInputs);
    expect(prompt?.props.onSelectSingleOption).toBe(prompt?.props.onToggleOption);
  });

  it("keeps the active turn's intermediate answer out of the group transcript", () => {
    const turnId = TurnId.make("turn-active");
    const timestamp = "2026-09-11T12:00:00.000Z";
    mocks.groupMessages = [
      {
        id: MessageId.make("group-user"),
        role: "user",
        text: "Compare the options.",
        turnId,
        streaming: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: MessageId.make("group-intermediate"),
        role: "assistant",
        text: "Let me look.",
        turnId,
        respondingBotId: BotId.make(parentBot.id),
        streaming: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ];
    mocks.latestTurn = {
      turnId,
      state: "running",
      requestedAt: timestamp,
      startedAt: timestamp,
      completedAt: null,
      assistantMessageId: null,
    };

    hooks.beginRender();
    const rendered = GroupThreadLanding({ groupId: group.id });
    const provider = visitElements(
      rendered,
      (element) => element.props.testId === "group-provider-message",
    );
    const sent = visitElements(
      rendered,
      (element) => element.props.testId === "group-user-message",
    );

    expect(sent).not.toBeNull();
    expect(provider).toBeNull();
  });

  it("shows the group answer again once the turn settles", () => {
    const turnId = TurnId.make("turn-settled");
    const timestamp = "2026-09-11T12:00:00.000Z";
    mocks.groupMessages = [
      {
        id: MessageId.make("group-user"),
        role: "user",
        text: "Compare the options.",
        turnId,
        streaming: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: MessageId.make("group-answer"),
        role: "assistant",
        text: "Here is the comparison.",
        turnId,
        respondingBotId: BotId.make(parentBot.id),
        streaming: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ];

    hooks.beginRender();
    const provider = visitElements(
      GroupThreadLanding({ groupId: group.id }),
      (element) => element.props.testId === "group-provider-message",
    );

    expect(provider).not.toBeNull();
  });

  it.each([
    ["bot", () => BotThreadLanding({ botId: parentBot.id })],
    ["group", () => GroupThreadLanding({ groupId: group.id })],
  ])("does not report the %s composer as sending while an approval waits", (_kind, render) => {
    const timestamp = "2026-09-11T12:00:00.000Z";
    mocks.latestTurn = {
      turnId: TurnId.make("turn-approval"),
      state: "running",
      requestedAt: timestamp,
      startedAt: timestamp,
      completedAt: null,
      assistantMessageId: null,
    };
    mocks.pendingApproval = {
      requestId: ApprovalRequestId.make("approval-1"),
      requestKind: "command",
      createdAt: timestamp,
      detail: "Run the tests?",
      options: [
        { decision: "decline", label: "Decline" },
        { decision: "accept", label: "Allow" },
      ],
    };

    hooks.beginRender();
    const composer = visitElements(
      render(),
      (element) => element.type === BotPromptComposer,
    ) as ReactElement<Parameters<typeof BotPromptComposer>[0]> | null;

    expect(composer?.props.busy).toBe(false);
    expect(composer?.props.activitySlot).toBeNull();
  });

  it.each([
    ["bot", () => BotThreadLanding({ botId: parentBot.id })],
    ["group", () => GroupThreadLanding({ groupId: group.id })],
  ])("reports the %s composer as sending while a turn runs", (_kind, render) => {
    const timestamp = "2026-09-11T12:00:00.000Z";
    mocks.latestTurn = {
      turnId: TurnId.make("turn-running"),
      state: "running",
      requestedAt: timestamp,
      startedAt: timestamp,
      completedAt: null,
      assistantMessageId: null,
    };

    hooks.beginRender();
    const composer = visitElements(
      render(),
      (element) => element.type === BotPromptComposer,
    ) as ReactElement<Parameters<typeof BotPromptComposer>[0]> | null;

    expect(composer?.props.busy).toBe(true);
    expect(composer?.props.activitySlot).not.toBeNull();
  });

  it.each([
    ["bot", () => BotThreadLanding({ botId: parentBot.id })],
    ["group", () => GroupThreadLanding({ groupId: group.id })],
  ])("renders an active runtime warning in the %s conversation", (_kind, render) => {
    const turnId = TurnId.make("turn-warning");
    const timestamp = "2026-09-11T12:00:00.000Z";
    mocks.latestTurn = {
      turnId,
      state: "running",
      requestedAt: timestamp,
      startedAt: timestamp,
      completedAt: null,
      assistantMessageId: null,
    };
    mocks.activities = [
      {
        id: EventId.make("warning-current"),
        tone: "info",
        kind: "runtime.warning",
        summary: "Usage limit reached",
        payload: { message: "Claude is paused until the usage window resets." },
        turnId,
        createdAt: timestamp,
      },
    ];

    hooks.beginRender();
    const banner = visitElements(
      render(),
      (element) => element.type === ThreadRuntimeWarningBanner,
    ) as ReactElement<Parameters<typeof ThreadRuntimeWarningBanner>[0]> | null;

    expect(banner?.props.warning).toBe("Claude is paused until the usage window resets.");
  });
});
