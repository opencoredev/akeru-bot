import { BotId, EnvironmentId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  save: vi.fn<
    (value: {
      input: { connectionId: string; token?: string; name: string };
    }) => Promise<{ _tag: "Success" | "Failure" }>
  >(),
  attach:
    vi.fn<
      (value: {
        input: { connectionId: string; botId: string };
      }) => Promise<{ _tag: "Success" | "Failure" }>
    >(),
  toast: vi.fn(),
  buttons: new Map<string, { onClick?: () => void; disabled?: boolean }>(),
  inputs: new Map<string, { onChange: (event: { currentTarget: { value: string } }) => void }>(),
  changeOpen: (_open: boolean) => {},
}));

vi.mock("../../state/bots", () => ({
  botEnvironment: { channels: { saveConnection: "save", attach: "attach" } },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "save" ? mocks.save : mocks.attach),
}));
vi.mock("./BotChannelsSettings", () => ({ parsePhotonHostedCredentials: vi.fn() }));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("../ui/button", () => ({
  Button: (props: { children: ReactNode; onClick?: () => void; disabled?: boolean }) => {
    if (typeof props.children === "string") mocks.buttons.set(props.children, props);
    return null;
  },
}));
vi.mock("../ui/input", () => ({
  Input: (props: {
    "aria-label": string;
    onChange: (event: { currentTarget: { value: string } }) => void;
  }) => {
    mocks.inputs.set(props["aria-label"], props);
    return null;
  },
}));
vi.mock("../ui/dialog", () => ({
  Dialog: (props: {
    children: ReactNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => {
    mocks.changeOpen = props.onOpenChange;
    return props.open ? props.children : null;
  },
  DialogPopup: ({ children }: { children: ReactNode }) => children,
  DialogHeader: ({ children }: { children: ReactNode }) => children,
  DialogTitle: () => null,
}));
vi.mock("../ui/select", () => ({
  Select: () => null,
  SelectItem: () => null,
  SelectPopup: () => null,
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

import { ChannelSetupDialog } from "./ChannelSetupDialog";

// This node-only suite gives ReactDOM a host without a browser DOM dependency.
class TestNode {
  parentNode: TestNode | null = null;
  childNodes: TestNode[] = [];
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly style = {};
  readonly tagName: string;
  readonly nodeName: string;
  private text = "";

  constructor(
    name: string,
    readonly ownerDocument: TestNode | null = null,
    readonly nodeType = 1,
  ) {
    this.tagName = name.toUpperCase();
    this.nodeName = this.tagName;
  }
  get textContent(): string {
    return this.text + this.childNodes.map((node) => node.textContent).join("");
  }
  set textContent(value: string) {
    this.text = value;
    this.childNodes = [];
  }
  appendChild(child: TestNode) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore(child: TestNode, before: TestNode) {
    child.parentNode = this;
    this.childNodes.splice(this.childNodes.indexOf(before), 0, child);
    return child;
  }
  removeChild(child: TestNode) {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }
  createElement(name: string) {
    return new TestNode(name, this);
  }
  createTextNode(text: string) {
    const node = new TestNode("#text", this, 3);
    node.textContent = text;
    return node;
  }
  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
  removeAttribute() {}
}

let root: import("react-dom/client").Root;
let container: TestNode;
const onSaved = vi.fn();
const onOpenChange = vi.fn();
const props = {
  environmentId: EnvironmentId.make("test-environment"),
  provider: "telegram" as const,
  bots: [{ id: BotId.make("test-bot"), name: "Test bot" }],
  open: true,
  onSaved,
  onOpenChange,
};

async function click(label: string) {
  const button = mocks.buttons.get(label);
  expect(button).toBeDefined();
  expect(button?.disabled).not.toBe(true);
  await act(async () => {
    button?.onClick?.();
  });
}

async function fill(label: string, value: string) {
  const input = mocks.inputs.get(label);
  expect(input).toBeDefined();
  await act(() => input?.onChange({ currentTarget: { value } }));
}

async function completeSetup() {
  await click("Continue");
  await fill("Telegram Bot token", "test-token");
  await click("Continue");
  await fill("Connection name", "Test line");
}

beforeEach(async () => {
  mocks.save.mockReset().mockResolvedValue({ _tag: "Success" });
  mocks.attach.mockReset().mockResolvedValue({ _tag: "Success" });
  mocks.toast.mockReset();
  mocks.buttons.clear();
  mocks.inputs.clear();
  onSaved.mockReset();
  onOpenChange.mockReset();
  const document = new TestNode("#document", null, 9);
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", {
    document,
    HTMLIFrameElement: TestNode,
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  const { createRoot } = await import("react-dom/client");
  root = createRoot(container as unknown as Element);
  await act(() => root.render(<ChannelSetupDialog {...props} />));
});

afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("ChannelSetupDialog recovery", () => {
  it("retries the saved profile without saving another connection or blaming credentials", async () => {
    mocks.attach.mockResolvedValueOnce({ _tag: "Failure" });
    await completeSetup();
    await click("Connect");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Connection saved. Could not connect Test bot.");
    expect(container.textContent).not.toMatch(/rejected|tokens|credentials/i);
    const connectionId = mocks.save.mock.calls[0]![0].input.connectionId;

    await click("Connect");

    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.attach.mock.calls.map(([value]) => value.input.connectionId)).toEqual([
      connectionId,
      connectionId,
    ]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("updates the same saved profile when credentials are corrected before retry", async () => {
    mocks.attach.mockResolvedValueOnce({ _tag: "Failure" });
    await completeSetup();
    await click("Connect");
    const connectionId = mocks.save.mock.calls[0]![0].input.connectionId;
    await click("Back");
    await fill("Telegram Bot token", "corrected-token");
    await click("Continue");
    await click("Connect");

    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(mocks.save.mock.calls[1]![0].input).toMatchObject({
      connectionId,
      token: "corrected-token",
    });
    expect(mocks.attach.mock.calls[1]![0].input.connectionId).toBe(connectionId);
  });

  it("does not attach or retain a profile when saving fails", async () => {
    mocks.save.mockResolvedValueOnce({ _tag: "Failure" });
    await completeSetup();
    await click("Connect");
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    await click("Connect");
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(mocks.attach).toHaveBeenCalledTimes(1);
  });

  it("keeps the pending operation when dismissal is attempted", async () => {
    let finish!: (value: { _tag: "Success" | "Failure" }) => void;
    mocks.attach.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await completeSetup();
    await click("Connect");
    await act(() => mocks.changeOpen(false));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(mocks.buttons.get("Connect")?.disabled).toBe(true);
    await act(async () => {
      finish({ _tag: "Failure" });
    });
    await click("Connect");
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });

  it("starts a new profile after a failed setup is dismissed and reopened", async () => {
    mocks.attach.mockResolvedValueOnce({ _tag: "Failure" });
    await completeSetup();
    await click("Connect");
    const firstId = mocks.save.mock.calls[0]![0].input.connectionId;
    await act(() => mocks.changeOpen(false));
    await act(() => root.render(<ChannelSetupDialog {...props} open={false} />));
    await act(() => root.render(<ChannelSetupDialog {...props} />));
    await completeSetup();
    await click("Connect");
    expect(mocks.save.mock.calls[1]![0].input.connectionId).not.toBe(firstId);
  });
});
