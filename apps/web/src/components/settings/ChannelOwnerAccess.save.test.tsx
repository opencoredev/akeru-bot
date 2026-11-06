import { Predicate } from "effect";
import { BotId, EnvironmentId } from "@akeru/contracts";
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ChannelBotAccessControls } from "./ChannelOwnerAccess";
import { TestNode, createChannelSetupActions } from "./channelSetupDialog.test-support";

type CommandResult = { readonly _tag: "Success"; readonly value: number };

type LinkCodeResult = { readonly _tag: "Success"; readonly value: string };

const mocks = vi.hoisted(() => ({
  access: [] as Array<{
    botId: string;
    provider: "slack" | "discord";
    allowedUserIds: string[];
    replyToOthers: boolean;
  }>,
  setAccess: vi.fn<(value: { input: { allowedUserIds: string[] } }) => Promise<CommandResult>>(),
  createLinkCode: vi.fn<() => Promise<LinkCodeResult>>(),
  buttons: new Map<string, { onClick?: () => void; disabled?: boolean }>(),
  inputs: new Map<string, { onChange: (event: { currentTarget: { value: string } }) => void }>(),
  values: new Map<string, string>(),
}));

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: <Selected,>(
    _environmentId: string,
    select: (settings: { channelBotAccess: typeof mocks.access }) => Selected,
  ) => select({ channelBotAccess: mocks.access }),
}));

vi.mock("../../state/bots", () => ({
  botEnvironment: { channels: { createLinkCode: "createLinkCode", setAccess: "setAccess" } },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: "createLinkCode" | "setAccess") =>
    command === "setAccess" ? mocks.setAccess : mocks.createLinkCode,
}));

vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

vi.mock("../ui/button", () => ({
  Button: (props: { children: ReactNode; onClick?: () => void; disabled?: boolean }) => {
    if (Predicate.isString(props.children)) mocks.buttons.set(props.children, props);

    return null;
  },
}));

vi.mock("../ui/input", () => ({
  Input: (props: {
    id: string;
    value: string;
    onChange: (event: { currentTarget: { value: string } }) => void;
  }) => {
    mocks.inputs.set(props.id, props);
    mocks.values.set(props.id, props.value);

    return null;
  },
}));

vi.mock("../ui/switch", () => ({ Switch: () => null }));

const environmentId = EnvironmentId.make("environment-1");

const botId = BotId.make("bot-1");

const field = `channel-allowlist-${botId}`;

const { click, fill } = createChannelSetupActions(mocks);

let root: import("react-dom/client").Root;

const FIRST_CONNECT = "2026-11-05T10:00:00.000Z";

const SECOND_CONNECT = "2026-11-05T10:05:00.000Z";

/** `connectedAt` defaults to the first connection while connected, and to none otherwise. */
const controls = (
  connected: boolean,
  assigned = botId,
  connectedAt: string | null = connected ? FIRST_CONNECT : null,
) => (
  <ChannelBotAccessControls
    environmentId={environmentId}
    provider="slack"
    botId={assigned}
    botName="Scout"
    connected={connected}
    connectedAt={connectedAt}
  />
);

const render = async (connected: boolean) => {
  const document = new TestNode("#document", null, 9);
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", {
    document,
    HTMLIFrameElement: TestNode,
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  root = createRoot(globalThis.document.createElement("div"));
  await act(() => root.render(controls(connected)));
};

beforeEach(() => {
  mocks.access = [];
  mocks.setAccess.mockReset();
  mocks.createLinkCode.mockReset();
  mocks.buttons.clear();
  mocks.inputs.clear();
  mocks.values.clear();
});

afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("ChannelBotAccessControls saving", () => {
  it("keeps an allowlist edit made while the save is in flight", async () => {
    await render(true);
    let resolveSave: (result: CommandResult) => void = () => {};

    mocks.setAccess.mockReturnValue(new Promise((resolve) => (resolveSave = resolve)));

    await fill(field, "U1");
    await click("Save");
    expect(mocks.setAccess.mock.calls[0]?.[0].input.allowedUserIds).toEqual(["U1"]);

    await fill(field, "U1, U2");
    mocks.access = [{ botId, provider: "slack", allowedUserIds: ["U1"], replyToOthers: false }];
    await act(async () => resolveSave({ _tag: "Success", value: 0 }));

    expect(mocks.values.get(field)).toBe("U1, U2");
    expect(mocks.buttons.get("Save")?.disabled).toBe(false);
  });

  it("clears the draft once the saved value matches it", async () => {
    await render(true);
    mocks.setAccess.mockResolvedValue({ _tag: "Success", value: 0 });

    await fill(field, "U1,U2");
    mocks.access = [
      { botId, provider: "slack", allowedUserIds: ["U1", "U2"], replyToOthers: false },
    ];
    await click("Save");

    expect(mocks.values.get(field)).toBe("U1, U2");
    expect(mocks.buttons.get("Save")?.disabled).toBe(true);
  });

  it("drops the drafts and link code when the connection moves to another bot", async () => {
    await render(true);
    mocks.createLinkCode.mockResolvedValue({ _tag: "Success", value: "ABCD2345" });

    await fill(field, "U1");
    await click("Create link code");
    expect(mocks.buttons.has("Create new code")).toBe(true);

    // Another client reassigned the connection, and the refreshed snapshot names a new bot.
    const nextBot = BotId.make("bot-2");
    mocks.buttons.clear();
    await act(() => root.render(controls(true, nextBot)));

    expect(mocks.values.get(`channel-allowlist-${nextBot}`)).toBe("");
    expect(mocks.buttons.has("Create new code")).toBe(false);
    expect(mocks.buttons.get("Create link code")?.disabled).toBe(false);
    expect(mocks.buttons.get("Save")?.disabled).toBe(true);
  });

  it("hides a link code once its channel disconnects, even after it reconnects", async () => {
    await render(true);
    mocks.createLinkCode.mockResolvedValue({ _tag: "Success", value: "ABCD2345" });

    await click("Create link code");
    expect(mocks.buttons.has("Create new code")).toBe(true);

    // The server deleted its pending codes when the channel stopped.
    mocks.buttons.clear();
    await act(() => root.render(controls(false)));
    mocks.buttons.clear();
    await act(() => root.render(controls(true, botId, SECOND_CONNECT)));

    expect(mocks.buttons.has("Create new code")).toBe(false);
    expect(mocks.buttons.get("Create link code")?.disabled).toBe(false);
  });

  it("drops a link code that arrives after its channel disconnected", async () => {
    await render(true);
    let resolveCode: (result: LinkCodeResult) => void = () => {};

    mocks.createLinkCode.mockReturnValue(new Promise((resolve) => (resolveCode = resolve)));

    await click("Create link code");
    mocks.buttons.clear();
    await act(() => root.render(controls(false)));
    mocks.buttons.clear();
    await act(() => root.render(controls(true, botId, SECOND_CONNECT)));
    await act(async () => resolveCode({ _tag: "Success", value: "ABCD2345" }));

    expect(mocks.buttons.has("Create new code")).toBe(false);
  });

  it("hides a link code after a reconnect the page never saw as disconnected", async () => {
    await render(true);
    mocks.createLinkCode.mockResolvedValue({ _tag: "Success", value: "ABCD2345" });

    await click("Create link code");
    mocks.buttons.clear();
    await act(() => root.render(controls(true, botId, SECOND_CONNECT)));

    expect(mocks.buttons.has("Create new code")).toBe(false);
  });

  it("shows the link code again when a failed reconnect keeps the old connection", async () => {
    await render(true);
    mocks.createLinkCode.mockResolvedValue({ _tag: "Success", value: "ABCD2345" });

    await click("Create link code");
    mocks.buttons.clear();
    await act(() => root.render(controls(false, botId, FIRST_CONNECT)));
    expect(mocks.buttons.has("Create new code")).toBe(false);

    mocks.buttons.clear();
    await act(() => root.render(controls(true, botId, FIRST_CONNECT)));

    expect(mocks.buttons.has("Create new code")).toBe(true);
  });

  it("offers a link code only while the channel is connected", async () => {
    await render(false);

    expect(mocks.buttons.get("Create link code")?.disabled).toBe(true);
  });
});
