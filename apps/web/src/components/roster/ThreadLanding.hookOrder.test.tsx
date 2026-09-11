import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, MessageId, ThreadId, type OrchestrationMessage } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Bot, Group } from "./types";

const mocks = vi.hoisted(() => ({
  groups: [] as Group[],
  bots: [] as Bot[],
  messages: [] as OrchestrationMessage[],
  mediaBlocked: false,
  setContext: vi.fn(),
  clearContextIf: vi.fn(),
  observe: vi.fn(),
  landing: vi.fn(),
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
vi.mock("../../state/session", () => ({
  useEnvironmentSessionState: () => ({ data: null, isPending: false }),
}));
vi.mock("./botEngineSelection", () => ({ resolveStickyBotEngine: () => null }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../../state/bots", () => ({ environmentPeopleAtom: () => null }));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => EnvironmentId.make("environment-1"),
  useEnvironmentConnectionState: () => ({ data: null }),
}));
vi.mock("../../state/entities", () => ({ useThreadActivities: () => [] }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: { inbox: [] } }) }));
vi.mock("../../state/server", () => ({
  primaryServerProvidersAtom: null,
  serverEnvironment: { subscriptionAuth: () => null },
}));
vi.mock("../../state/shell", () => ({ environmentSnapshotAtom: () => null }));
vi.mock("../../state/threads", () => ({ threadEnvironment: { setMessageReaction: null } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../settingsDialogStore", () => ({ openSettings: vi.fn() }));
vi.mock("../voice/VoiceCall", () => ({
  BotVoiceCallButton: () => null,
  useVoiceCall: () => ({ activeCall: mocks.mediaBlocked, startingBotId: null }),
  useOptionalVoiceCall: () => ({ activeCall: mocks.mediaBlocked, startingBotId: null }),
  voiceEnvironmentConnectionLost: () => false,
}));
vi.mock("../chat/ReplyPlaybackProvider", () => {
  const session = {
    synthesis: { provider: "test-provider", voice: "test-voice" },
    setContext: mocks.setContext,
    clearContextIf: mocks.clearContextIf,
    observe: mocks.observe,
    actionFor: () => undefined,
  };
  return { useOptionalReplyPlayback: () => session };
});
vi.mock("../ui/sidebar", () => ({
  SidebarInset: (props: unknown) => {
    mocks.landing(props);
    return null;
  },
}));
vi.mock("./botPresence", () => ({
  useBotPresence: () => "idle",
  useGroupPresence: () => "idle",
}));
vi.mock("./rosterStore", () => {
  const useRosterStore = (selector: (state: { groups: Group[]; bots: Bot[] }) => unknown) =>
    selector({ groups: mocks.groups, bots: mocks.bots });
  useRosterStore.getState = () => ({ selectBot: vi.fn() });
  return { useRosterStore };
});
vi.mock("./useBotThreadRuntime", () => ({
  useBotThreadRuntime: () => ({
    sending: false,
    respondingRequestIds: [],
    messages: mocks.messages,
    error: null,
    latestTurn: null,
    defaultProject: null,
    botReady: true,
    bootstrapped: true,
    linkedThreadRef: {
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-bot"),
    },
    pendingUserInputs: [],
    send: vi.fn(),
  }),
}));
vi.mock("./useRosterPendingApproval", () => ({
  useRosterPendingApproval: () => ({ pendingApproval: null }),
}));
vi.mock("./useGroupThreadRuntime", () => ({
  useGroupThreadRuntime: () => ({
    sending: false,
    respondingRequestIds: [],
    messages: mocks.messages,
    error: null,
    defaultProject: null,
    groupReady: true,
    bootstrapped: true,
    respondingBotId: null,
    linkedThreadRef: {
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-group"),
    },
    pendingUserInputs: [],
    send: vi.fn(),
  }),
}));

import { GroupThreadLanding } from "./GroupThreadLanding";
import { BotThreadLanding } from "./BotThreadLanding";

// Minimal ReactDOM host, matching DesktopOnboarding's unit tests.
class TestNode {
  parentNode: TestNode | null = null;
  childNodes: TestNode[] = [];
  readonly nodeName: string;
  readonly tagName: string;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly style = {};
  constructor(
    name: string,
    readonly ownerDocument: TestNode | null = null,
    readonly nodeType = 1,
  ) {
    this.nodeName = name.toUpperCase();
    this.tagName = this.nodeName;
  }
  set textContent(_value: string) {
    this.childNodes = [];
  }
  appendChild(child: TestNode) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild(child: TestNode) {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }
  insertBefore(child: TestNode, before: TestNode) {
    child.parentNode = this;
    this.childNodes.splice(this.childNodes.indexOf(before), 0, child);
    return child;
  }
  createElement(name: string) {
    return new TestNode(name, this);
  }
  createElementNS(_namespace: string, name: string) {
    return this.createElement(name);
  }
  createTextNode() {
    return new TestNode("#text", this, 3);
  }
  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
  removeAttribute() {}
}

const group: Group = {
  id: "perf-group",
  name: "Performance",
  bossBotId: null,
  members: [],
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
};
const bot: Bot = {
  id: "bot-1",
  name: "Akeru",
  title: "Teammate",
  label: null,
  description: null,
  disabledMcpServerIds: [],
  avatar: { kind: "dither", seed: "bot-1" },
  engine: null,
  sandbox: "local",
  runtimeMode: "approval-required",
  usageCap: null,
  voiceEnabled: false,
  groupId: null,
  pinned: false,
  archivedAt: null,
  createdAt: group.createdAt,
  updatedAt: group.updatedAt,
};
const message: OrchestrationMessage = {
  id: MessageId.make("reply-1"),
  role: "assistant",
  text: "Here is the group reply.",
  turnId: null,
  streaming: false,
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z",
};
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.groups = [];
  mocks.bots = [];
  mocks.messages = [];
  mocks.mediaBlocked = false;
  const document = new TestNode("#document", null, 9);
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { document, HTMLIFrameElement: TestNode });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div") as unknown as Element);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => root.render(<GroupThreadLanding groupId={group.id} />));
}

describe("thread landing reply playback hook order", () => {
  it.each(["missing", "archived"] as const)(
    "renders an initially %s bot then its available bot without a hook ordering error",
    async (state) => {
      const unavailableBots = state === "missing" ? [] : [{ ...bot, archivedAt: bot.updatedAt }];
      mocks.bots = unavailableBots;
      const renderBot = async () => {
        await act(async () => root.render(<BotThreadLanding botId={bot.id} />));
      };
      await renderBot();
      expect(mocks.landing).not.toHaveBeenCalled();

      mocks.bots = [bot];
      mocks.messages = [message];
      await expect(renderBot()).resolves.toBeUndefined();
      expect(mocks.landing).toHaveBeenCalled();
      expect(mocks.observe).toHaveBeenLastCalledWith([message]);
      expect(mocks.setContext).toHaveBeenLastCalledWith(
        expect.objectContaining({ threadId: "thread-bot", mediaBlocked: false }),
      );

      mocks.bots = unavailableBots;
      mocks.landing.mockClear();
      await expect(renderBot()).resolves.toBeUndefined();
      expect(mocks.landing).not.toHaveBeenCalled();
    },
  );
  it("renders an initially missing group then its hydrated group without a hook ordering error", async () => {
    await render();
    expect(mocks.landing).not.toHaveBeenCalled();

    mocks.groups = [group];
    mocks.messages = [message];
    await expect(render()).resolves.toBeUndefined();
    expect(mocks.landing).toHaveBeenCalledWith(
      expect.objectContaining({ "aria-label": "Performance group chat" }),
    );
    expect(mocks.observe).toHaveBeenLastCalledWith([message]);
    expect(mocks.setContext).toHaveBeenLastCalledWith({
      environmentId: "environment-1",
      threadId: "thread-group",
      provider: "test-provider",
      voice: "test-voice",
      connected: true,
      mediaBlocked: false,
    });

    mocks.mediaBlocked = true;
    await render();
    expect(mocks.setContext).toHaveBeenLastCalledWith(
      expect.objectContaining({ mediaBlocked: true }),
    );

    mocks.groups = [];
    mocks.landing.mockClear();
    await expect(render()).resolves.toBeUndefined();
    expect(mocks.landing).not.toHaveBeenCalled();
  });
});
