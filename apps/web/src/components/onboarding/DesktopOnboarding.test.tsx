import { EnvironmentId, type SubscriptionProviderId } from "@t3tools/contracts";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ProviderApiKeyForm } from "../settings/ProvidersPanel";
import { DEFAULT_DESKTOP_ONBOARDING_DRAFT } from "./desktopOnboarding.logic";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  complete: vi.fn(),
  cancel: vi.fn(),
  poll: vi.fn(),
  refresh: vi.fn(),
  next: vi.fn(),
  open: vi.fn(),
  form: null as ComponentProps<typeof ProviderApiKeyForm> | null,
  input: null as { onChange: (event: { currentTarget: { value: string } }) => void } | null,
  buttons: new Map<string, { onClick?: () => void; disabled?: boolean }>(),
  connected: false,
}));

vi.mock("../../state/server", () => ({
  serverEnvironment: {
    subscriptionAuth: () => ({}),
    startSubscriptionAuth: "start",
    completeSubscriptionAuth: "complete",
    cancelSubscriptionAuth: "cancel",
    pollSubscriptionAuth: "poll",
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { providers: [{ provider: "openai-codex", connected: mocks.connected }] },
    refresh: mocks.refresh,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: "start" | "complete" | "cancel" | "poll") => mocks[command],
}));
vi.mock("../settings/ProvidersPanel", () => ({
  ProviderApiKeyForm: (props: ComponentProps<typeof ProviderApiKeyForm>) => {
    mocks.form = props;
    return null;
  },
}));
vi.mock("../ui/button", () => ({
  Button: (props: { children?: unknown; onClick?: () => void; disabled?: boolean }) => {
    const label = (Array.isArray(props.children) ? props.children : [props.children])
      .filter((child) => typeof child === "string")
      .join("");
    mocks.buttons.set(label, props);
    return null;
  },
}));
vi.mock("../ui/input", () => ({
  Input: (props: NonNullable<typeof mocks.input>) => {
    mocks.input = props;
    return null;
  },
}));

import { SubscriptionStep } from "./DesktopOnboarding";

// Match the minimal ReactDOM host used by PreviewView's unit tests.
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

let root: Root;
const environmentId = EnvironmentId.make("onboarding-environment");
const success = <T,>(value: T) => ({ _tag: "Success" as const, value });

async function render(providerId: SubscriptionProviderId = "openai-codex") {
  await act(async () =>
    root.render(
      <SubscriptionStep
        environmentId={environmentId}
        draft={{ ...DEFAULT_DESKTOP_ONBOARDING_DRAFT, providerId }}
        onChange={vi.fn()}
        onContinue={mocks.next}
      />,
    ),
  );
}

async function click(label: string) {
  const button = mocks.buttons.get(label);
  expect(button).toBeDefined();
  expect(button?.disabled).not.toBe(true);
  await act(async () => button?.onClick?.());
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buttons.clear();
  mocks.form = null;
  mocks.input = null;
  mocks.connected = false;
  mocks.start.mockResolvedValue(success({ loginId: "key-login" }));
  mocks.complete.mockResolvedValue(success({ status: "connected" }));
  mocks.cancel.mockResolvedValue(success({}));
  const document = new TestNode("#document", null, 9);
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", {
    document,
    HTMLIFrameElement: TestNode,
    location: { search: "" },
    open: mocks.open,
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div") as unknown as Element);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("onboarding API-key connections", () => {
  it.each(["openai-codex", "anthropic", "kimi-for-coding"] as const)(
    "saves a %s key and custom endpoint, then continues",
    async (provider) => {
      await render(provider);
      await click("Use an API key");
      expect(mocks.form?.supportsBaseUrl).toBe(true);
      await act(async () => {
        mocks.form?.onKeyChange(" test-key ");
        mocks.form?.onBaseUrlChange("https://proxy.example/v1");
      });
      await act(async () => mocks.form?.onSave());
      expect(mocks.start).toHaveBeenCalledWith({
        environmentId,
        input: {
          provider,
          authMode: "api-key",
          baseUrl: "https://proxy.example/v1",
        },
      });
      expect(mocks.complete).toHaveBeenCalledWith({
        environmentId,
        input: {
          loginId: "key-login",
          code: "test-key",
        },
      });
      expect(mocks.refresh).toHaveBeenCalled();
      expect(mocks.next).toHaveBeenCalledOnce();
      expect(mocks.open).not.toHaveBeenCalled();
    },
  );

  it("keeps the form busy and does not continue until the key is saved", async () => {
    let finish!: (value: ReturnType<typeof success<{ status: "connected" }>>) => void;
    const completion = new Promise<ReturnType<typeof success<{ status: "connected" }>>>(
      (resolve) => {
        finish = resolve;
      },
    );
    mocks.complete.mockReturnValue(completion);
    await render();
    await click("Use an API key");
    await act(async () => mocks.form?.onKeyChange("test-key"));
    await act(async () => mocks.form?.onSave());
    expect(mocks.form?.busy).toBe(true);
    expect(mocks.next).not.toHaveBeenCalled();
    await act(async () => mocks.form?.onSave());
    expect(mocks.start).toHaveBeenCalledOnce();
    await act(async () => finish(success({ status: "connected" })));
    expect(mocks.next).toHaveBeenCalledOnce();
  });

  it("keeps failed saves on the key form and cancels the pending login", async () => {
    mocks.complete.mockResolvedValue(success({ status: "failed", error: "Key rejected" }));
    await render("anthropic");
    await click("Use an API key");
    await act(async () => mocks.form?.onKeyChange("test-key"));
    await act(async () => mocks.form?.onSave());
    expect(mocks.form?.error).toBe("Key rejected");
    expect(mocks.form?.busy).toBe(false);
    expect(mocks.cancel).toHaveBeenCalledWith({ environmentId, input: { loginId: "key-login" } });
    expect(mocks.next).not.toHaveBeenCalled();
  });

  it("rejects invalid endpoints before starting a login", async () => {
    await render();
    await click("Use an API key");
    await act(async () => {
      mocks.form?.onKeyChange("test-key");
      mocks.form?.onBaseUrlChange("https://user:password@proxy.example/v1");
    });
    await act(async () => mocks.form?.onSave());
    expect(mocks.form?.error).toContain("without credentials");
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.next).not.toHaveBeenCalled();
  });

  it("clears the key and endpoint when cancelled", async () => {
    await render();
    await click("Use an API key");
    await act(async () => {
      mocks.form?.onKeyChange("test-key");
      mocks.form?.onBaseUrlChange("https://proxy.example/v1");
    });
    await act(async () => mocks.form?.onCancel());
    await click("Use an API key");
    expect(mocks.form?.apiKey).toBe("");
    expect(mocks.form?.baseUrl).toBe("");
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("keeps Grok on its default endpoint", async () => {
    await render("xai");
    await click("Use an API key");
    expect(mocks.form?.supportsBaseUrl).toBe(false);
    await act(async () => mocks.form?.onKeyChange("test-key"));
    await act(async () => mocks.form?.onSave());
    expect(mocks.start).toHaveBeenCalledWith({
      environmentId,
      input: { provider: "xai", authMode: "api-key" },
    });
  });

  it("opens the key form directly for OpenCode Go", async () => {
    await render("opencode-go");
    await click("Connect OpenCode Go");
    expect(mocks.form?.supportsBaseUrl).toBe(true);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("preserves OAuth and enables Claude paste completion after starting", async () => {
    mocks.start.mockResolvedValue(
      success({
        loginId: "oauth-login",
        provider: "anthropic",
        completion: "paste",
        url: "https://claude.example/login",
      }),
    );
    await render("anthropic");
    await click("Connect Claude");
    expect(mocks.start).toHaveBeenCalledWith({ environmentId, input: { provider: "anthropic" } });
    expect(mocks.open).toHaveBeenCalledWith(
      "https://claude.example/login",
      "_blank",
      "noopener,noreferrer",
    );
    expect(mocks.form).toBeNull();
    await act(async () => mocks.input?.onChange({ currentTarget: { value: "oauth-code" } }));
    await click("Connect");
    expect(mocks.complete).toHaveBeenCalledWith({
      environmentId,
      input: { loginId: "oauth-login", code: "oauth-code" },
    });
    expect(mocks.next).not.toHaveBeenCalled();
  });

  it("lets an already connected API-only user continue without OAuth", async () => {
    mocks.connected = true;
    await render();
    await click("Continue");
    expect(mocks.next).toHaveBeenCalledOnce();
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
