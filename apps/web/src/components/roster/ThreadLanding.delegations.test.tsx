import type { ReactElement } from "react";
import {
  AkeruDelegationRecord,
  BotId,
  EnvironmentId,
  ThreadId,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";
import type { Bot, Group } from "./types";

const mocks = vi.hoisted(() => ({
  providersAtom: Symbol("providers"),
  snapshotAtom: Symbol("snapshot"),
  peopleAtom: Symbol("people"),
  snapshot: null as OrchestrationShellSnapshot | null,
  bots: [] as Bot[],
  groups: [] as Group[],
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
    messages: [],
    error: null,
    latestTurn: null,
    defaultProject: null,
    pendingUserInputs: [],
    pendingUserInputAnswers: {},
    pendingUserInputQuestionIndex: 0,
    selectPendingUserInputOption: vi.fn(),
    advancePendingUserInput: vi.fn(),
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
});
