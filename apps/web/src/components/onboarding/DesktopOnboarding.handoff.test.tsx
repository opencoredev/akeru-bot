import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  DEFAULT_DESKTOP_ONBOARDING_DRAFT,
  DESKTOP_ONBOARDING_COMPLETED_STORAGE_KEY,
  DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY,
  DESKTOP_ONBOARDING_STORAGE_KEY,
} from "./desktopOnboarding.logic";

const BOT_ID = "bot-ada";

const HANDOFF = JSON.stringify({ environmentId: "onboarding-environment", botId: BOT_ID });

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  selectBot: vi.fn(),
  toast: vi.fn(),
  environmentId: "onboarding-environment",
  rosterLoaded: true,
  serverBots: [{ id: "bot-ada", archivedAt: null }] as Array<{
    id: string;
    archivedAt: string | null;
  }>,
}));

vi.mock("../../env", () => ({ isElectron: true }));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) => {
    if (atom === "shell") return { status: "live" };

    if (atom === "rosterLoaded") return mocks.rosterLoaded;

    if (atom === "bots") return mocks.serverBots;

    return [];
  },
}));

vi.mock("../../state/bots", () => ({
  botEnvironment: { create: "create" },
  environmentBotsAtom: () => "bots",
  environmentRosterLoadedAtom: () => "rosterLoaded",
}));

vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));

vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => mocks.environmentId,
}));

vi.mock("../../state/shell", () => ({
  environmentShell: { stateValueAtom: () => "shell" },
}));

vi.mock("../../state/server", () => ({
  serverEnvironment: { providersValueAtom: () => "providers" },
}));

vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({}) }));

vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));

vi.mock("../roster/rosterStore", () => {
  const state = { bots: [{ id: "bot-ada", engine: null }] };

  return {
    useRosterStore: Object.assign(<T,>(select: (value: typeof state) => T) => select(state), {
      getState: () => ({ selectBot: mocks.selectBot }),
    }),
  };
});

vi.mock("./DesktopOnboardingSurface", () => ({ OnboardingSurface: () => null }));

import { DesktopOnboarding } from "./DesktopOnboarding";

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
  getElementById() {
    return null;
  }
  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
  removeAttribute() {}
}

let root: Root;

let storage: Map<string, string>;

function mount() {
  const document = window.document;
  root = createRoot(document.createElement("div"));

  return act(async () => root.render(<DesktopOnboarding Surface={() => null} />));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rosterLoaded = true;
  mocks.environmentId = "onboarding-environment";
  mocks.serverBots = [{ id: BOT_ID, archivedAt: null }];
  mocks.navigate.mockResolvedValue(undefined);
  storage = new Map([
    [
      DESKTOP_ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_DESKTOP_ONBOARDING_DRAFT,
        name: "Ada",
        botId: BOT_ID,
      }),
    ],
  ]);
  const document = new TestNode("#document", null, 9);
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", {
    document,
    HTMLIFrameElement: TestNode,
    location: { search: "" },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("onboarding handoff", () => {
  it("opens the created bot chat when setup is interrupted after create", async () => {
    await mount();

    expect(storage.get(DESKTOP_ONBOARDING_COMPLETED_STORAGE_KEY)).toBe("1");
    expect(mocks.selectBot).toHaveBeenCalledWith(BOT_ID);
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/bots/$botId",
      params: { botId: BOT_ID },
      replace: true,
    });
    expect(storage.has(DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY)).toBe(false);
  });

  it("routes to the chat once after a reload interrupts the handoff", async () => {
    storage.set(DESKTOP_ONBOARDING_COMPLETED_STORAGE_KEY, "1");
    storage.set(DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY, HANDOFF);
    storage.delete(DESKTOP_ONBOARDING_STORAGE_KEY);
    mocks.rosterLoaded = false;
    await mount();

    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(storage.get(DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY)).toBe(HANDOFF);

    mocks.rosterLoaded = true;
    await act(async () => root.render(<DesktopOnboarding Surface={() => null} />));
    expect(mocks.selectBot).toHaveBeenCalledExactlyOnceWith(BOT_ID);
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/bots/$botId",
      params: { botId: BOT_ID },
      replace: true,
    });
    expect(storage.has(DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY)).toBe(false);

    await act(async () => root.unmount());
    await mount();
    expect(mocks.navigate).toHaveBeenCalledOnce();
  });

  it("keeps a pending chat through another environment and a delayed roster", async () => {
    storage.set(DESKTOP_ONBOARDING_COMPLETED_STORAGE_KEY, "1");
    storage.set(DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY, HANDOFF);
    storage.delete(DESKTOP_ONBOARDING_STORAGE_KEY);
    mocks.environmentId = "other-environment";
    mocks.serverBots = [];
    await mount();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(storage.get(DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY)).toBe(HANDOFF);

    mocks.environmentId = "onboarding-environment";
    mocks.rosterLoaded = false;
    await act(async () => root.render(<DesktopOnboarding Surface={() => null} />));
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(storage.get(DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY)).toBe(HANDOFF);

    mocks.rosterLoaded = true;
    await act(async () => root.render(<DesktopOnboarding Surface={() => null} />));
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(storage.get(DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY)).toBe(HANDOFF);

    mocks.serverBots = [{ id: BOT_ID, archivedAt: null }];
    await act(async () => root.render(<DesktopOnboarding Surface={() => null} />));
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/bots/$botId",
      params: { botId: BOT_ID },
      replace: true,
    });
    expect(storage.has(DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY)).toBe(false);
  });

  it("clears a pending chat when its bot was archived", async () => {
    storage.set(DESKTOP_ONBOARDING_COMPLETED_STORAGE_KEY, "1");
    storage.set(DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY, HANDOFF);
    storage.delete(DESKTOP_ONBOARDING_STORAGE_KEY);
    mocks.serverBots = [{ id: BOT_ID, archivedAt: "2026-09-29T00:00:00.000Z" }];

    await mount();

    expect(storage.has(DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY)).toBe(false);
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Your new bot was archived before its chat opened. Create or select another bot.",
      }),
    );
  });

  it("keeps the handoff when navigation fails so reload can retry", async () => {
    storage.set(DESKTOP_ONBOARDING_COMPLETED_STORAGE_KEY, "1");
    storage.set(DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY, HANDOFF);
    storage.delete(DESKTOP_ONBOARDING_STORAGE_KEY);
    mocks.navigate.mockRejectedValueOnce(new Error("route failed"));

    await mount();
    expect(mocks.navigate).toHaveBeenCalledOnce();
    expect(storage.get(DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY)).toBe(HANDOFF);
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not reopen your new chat. Reload to try again." }),
    );

    await act(async () => root.unmount());
    await mount();
    expect(mocks.navigate).toHaveBeenCalledTimes(2);
    expect(storage.has(DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY)).toBe(false);
  });
});
