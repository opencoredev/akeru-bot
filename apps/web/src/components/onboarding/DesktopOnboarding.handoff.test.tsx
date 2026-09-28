import { act, forwardRef, useEffect, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { OnboardingPreview } from "./OnboardingPreview";
import {
  DEFAULT_DESKTOP_ONBOARDING_DRAFT,
  DESKTOP_ONBOARDING_COMPLETED_STORAGE_KEY,
  DESKTOP_ONBOARDING_DESTINATION_TIMEOUT_MS,
  DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY,
  DESKTOP_ONBOARDING_REVEAL_DURATION_MS,
  DESKTOP_ONBOARDING_STORAGE_KEY,
  desktopOnboardingHandoffDurationMs,
} from "./desktopOnboarding.logic";

const BOT_ID = "bot-ada";
const HANDOFF = JSON.stringify({ environmentId: "onboarding-environment", botId: BOT_ID });

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  selectBot: vi.fn(),
  toast: vi.fn(),
  environmentId: "onboarding-environment",
  rosterLoaded: true,
  serverBots: [{ id: "bot-ada" }],
  preview: null as ComponentProps<typeof OnboardingPreview> | null,
  previewMounted: false,
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
    useRosterStore: Object.assign((select: (value: typeof state) => unknown) => select(state), {
      getState: () => ({ selectBot: mocks.selectBot }),
    }),
  };
});
vi.mock("motion/react", () => {
  const Div = forwardRef<HTMLDivElement, Record<string, unknown>>(
    ({ initial: _i, animate: _a, exit: _e, transition: _t, children, ...rest }, ref) => (
      <div ref={ref} {...rest}>
        {children as ReactNode}
      </div>
    ),
  );
  return {
    AnimatePresence: ({ children }: { children?: ReactNode }) => children,
    motion: { div: Div },
    useReducedMotion: () => false,
  };
});
vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  createPortal: (node: ReactNode) => node,
}));
vi.mock("./OnboardingPreview", () => ({
  OnboardingPreview: (props: ComponentProps<typeof OnboardingPreview>) => {
    mocks.preview = props;
    useEffect(() => {
      mocks.previewMounted = true;
      return () => {
        mocks.previewMounted = false;
      };
    }, []);
    return null;
  },
}));
vi.mock("./OnboardingGoalStep", () => ({ OnboardingGoalStep: () => null }));
vi.mock("../settings/ProvidersPanel", () => ({ ProviderApiKeyForm: () => null }));
vi.mock("../ui/button", () => ({ Button: () => null }));
vi.mock("../ui/alert-dialog", () => {
  const Empty = () => null;
  return {
    AlertDialog: Empty,
    AlertDialogClose: Empty,
    AlertDialogDescription: Empty,
    AlertDialogFooter: Empty,
    AlertDialogHeader: Empty,
    AlertDialogPopup: Empty,
    AlertDialogTitle: Empty,
  };
});

import { DesktopOnboarding } from "./DesktopOnboarding";

// Match the minimal ReactDOM host used by DesktopOnboarding's unit tests.
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
  const document = window.document as unknown as TestNode;
  root = createRoot(document.createElement("div") as unknown as Element);
  return act(async () => root.render(<DesktopOnboarding />));
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  // Let the navigation promise settle.
  await act(async () => {});
}

async function send() {
  expect(mocks.previewMounted).toBe(true);
  await act(async () => mocks.preview?.onMessageSent("Draft a first batch of posts"));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.preview = null;
  mocks.previewMounted = false;
  mocks.rosterLoaded = true;
  mocks.environmentId = "onboarding-environment";
  mocks.serverBots = [{ id: BOT_ID }];
  mocks.navigate.mockResolvedValue(undefined);
  storage = new Map([
    [
      DESKTOP_ONBOARDING_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_DESKTOP_ONBOARDING_DRAFT,
        step: "message",
        goal: "Help me post on LinkedIn",
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
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeout: (id: number) => clearTimeout(id),
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("onboarding handoff", () => {
  it("opens the chat, waits for the sent message, then fades setup away", async () => {
    await mount();
    await send();

    expect(storage.get(DESKTOP_ONBOARDING_COMPLETED_STORAGE_KEY)).toBe("1");
    expect(storage.has(DESKTOP_ONBOARDING_STORAGE_KEY)).toBe(false);
    expect(storage.get(DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY)).toBe(HANDOFF);

    await advance(desktopOnboardingHandoffDurationMs(false));
    expect(mocks.selectBot).toHaveBeenCalledWith(BOT_ID);
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/bots/$botId",
      params: { botId: BOT_ID },
      replace: true,
    });
    expect(storage.has(DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY)).toBe(false);
    // The chat route is open but has not shown the message yet.
    expect(mocks.preview?.handoff).toBe("opening");

    await act(async () => mocks.preview?.onDestinationReady());
    expect(mocks.preview?.handoff).toBe("revealing");

    await advance(DESKTOP_ONBOARDING_REVEAL_DURATION_MS);
    expect(mocks.previewMounted).toBe(false);
  });

  it("lifts setup after the timeout when the chat never reports ready", async () => {
    await mount();
    await send();

    await advance(desktopOnboardingHandoffDurationMs(false));
    expect(mocks.preview?.handoff).toBe("opening");

    await advance(
      DESKTOP_ONBOARDING_DESTINATION_TIMEOUT_MS - 1 - desktopOnboardingHandoffDurationMs(false),
    );
    expect(mocks.preview?.handoff).toBe("opening");

    await advance(1);
    expect(mocks.preview?.handoff).toBe("revealing");

    await advance(DESKTOP_ONBOARDING_REVEAL_DURATION_MS);
    expect(mocks.previewMounted).toBe(false);
  });

  it("routes to the chat once after a reload interrupts the handoff", async () => {
    await mount();
    await send();
    await advance(desktopOnboardingHandoffDurationMs(false) - 1);
    expect(mocks.navigate).not.toHaveBeenCalled();

    // Reload: the app starts over with setup complete and the handoff pending.
    await act(async () => root.unmount());
    mocks.preview = null;
    mocks.rosterLoaded = false;
    await mount();

    expect(mocks.previewMounted).toBe(false);
    expect(mocks.preview).toBeNull();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(storage.get(DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY)).toBe(HANDOFF);

    mocks.rosterLoaded = true;
    await act(async () => root.render(<DesktopOnboarding />));
    expect(mocks.selectBot).toHaveBeenCalledExactlyOnceWith(BOT_ID);
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/bots/$botId",
      params: { botId: BOT_ID },
      replace: true,
    });
    expect(storage.has(DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY)).toBe(false);

    // A second start has nothing left to recover.
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
    await act(async () => root.render(<DesktopOnboarding />));
    mocks.rosterLoaded = true;
    await act(async () => root.render(<DesktopOnboarding />));
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(storage.get(DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY)).toBe(HANDOFF);

    mocks.serverBots = [{ id: BOT_ID }];
    await act(async () => root.render(<DesktopOnboarding />));
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/bots/$botId",
      params: { botId: BOT_ID },
      replace: true,
    });
    expect(storage.has(DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY)).toBe(false);
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
