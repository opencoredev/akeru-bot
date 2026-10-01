import { Predicate } from "effect";
import { BotId, ChannelConnectionId, OrchestrationDispatchCommandError } from "@akeru/contracts";
import * as Cause from "effect/Cause";
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ChannelSetupDialog } from "./ChannelSetupDialog";
import {
  TestNode,
  firstProject,
  botProject,
  createChannelSetupActions,
  createChannelSetupProps,
} from "./channelSetupDialog.test-support";

const mocks = vi.hoisted(() => ({
  save: vi.fn<
    (value: {
      input: { connectionId: string; token?: string; name: string };
    }) => Promise<{ _tag: "Success" | "Failure" }>
  >(),
  attach:
    vi.fn<
      (value: {
        input: { connectionId: string; botId: string; projectId: string };
      }) => Promise<{ _tag: "Success" | "Failure"; cause?: Cause.Cause<unknown> }>
    >(),
  detach: vi.fn<
    (value: { input: { botId: string; provider: string } }) => Promise<{
      _tag: "Success" | "Failure";
    }>
  >(),
  disconnect: vi.fn<
    (value: { input: { botId: string; provider: string } }) => Promise<{
      _tag: "Success" | "Failure";
    }>
  >(),
  deleteConnection:
    vi.fn<
      (value: { input: { connectionId: string } }) => Promise<{ _tag: "Success" | "Failure" }>
    >(),
  calls: [] as string[],
  toast: vi.fn(),
  buttons: new Map<string, { onClick?: () => void; disabled?: boolean }>(),
  inputs: new Map<string, { onChange: (event: { currentTarget: { value: string } }) => void }>(),
  changeOpen: (_open: boolean) => {},
  snapshot: null as unknown,
  projectSelect: null as null | {
    projects: ReadonlyArray<{ id: string; title: string }>;
    value: string | null;
    onChange: (projectId: string) => void;
  },
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.snapshot }));

vi.mock("../../state/shell", () => ({ environmentSnapshotAtom: () => "snapshot" }));

vi.mock("./ChannelProjectSelect", () => ({
  ChannelProjectSelect: (props: NonNullable<typeof mocks.projectSelect>) => {
    mocks.projectSelect = props;

    return null;
  },
}));

vi.mock("../../state/bots", () => ({
  botEnvironment: {
    channels: {
      saveConnection: "save",
      attach: "attach",
      detach: "detach",
      disconnect: "disconnect",
      deleteConnection: "deleteConnection",
    },
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: "save" | "attach" | "detach" | "disconnect" | "deleteConnection") =>
    mocks[command],
}));

vi.mock("./BotChannelsSettings", () => ({ parsePhotonHostedCredentials: vi.fn() }));

vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));

vi.mock("../ui/button", () => ({
  Button: (props: { children: ReactNode; onClick?: () => void; disabled?: boolean }) => {
    if (Predicate.isString(props.children)) mocks.buttons.set(props.children, props);

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
  DialogTitle: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("../ui/select", () => ({
  Select: () => null,
  SelectItem: () => null,
  SelectPopup: () => null,
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

let root: import("react-dom/client").Root;

let container: TestNode;

const onSaved = vi.fn();

const onOpenChange = vi.fn();

const props = createChannelSetupProps(onSaved, onOpenChange);

const { click, fill, completeSetup } = createChannelSetupActions(mocks);

beforeEach(async () => {
  mocks.snapshot = {
    projects: [
      { id: firstProject, title: "First", updatedAt: "2026-09-02T00:00:00.000Z" },
      { id: botProject, title: "Bot work", updatedAt: "2026-09-01T00:00:00.000Z" },
    ],
    threads: [
      {
        projectId: botProject,
        botId: "test-bot",
        updatedAt: "2026-09-03T00:00:00.000Z",
        archivedAt: null,
      },
    ],
  };
  mocks.projectSelect = null;
  mocks.save.mockReset().mockResolvedValue({ _tag: "Success" });
  mocks.attach.mockReset().mockResolvedValue({ _tag: "Success" });
  mocks.detach.mockReset().mockResolvedValue({ _tag: "Success" });
  mocks.disconnect.mockReset().mockResolvedValue({ _tag: "Success" });
  mocks.deleteConnection.mockReset().mockResolvedValue({ _tag: "Success" });
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
    expect(container.textContent).toContain("Test line is saved but could not connect.");
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

  it("names the connection and explains a categorized failure", async () => {
    mocks.attach.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(
        new OrchestrationDispatchCommandError({
          message: "The channel credentials were rejected.",
          channelFailureCategory: "credentials",
        }),
      ),
    });
    await completeSetup();
    await click("Connect");
    expect(container.textContent).toContain(
      "Test line is saved but could not connect. Telegram rejected the bot token.",
    );
    expect(container.textContent).not.toContain("Test bot");
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

describe("ChannelSetupDialog credential update", () => {
  const oldConnection = ChannelConnectionId.make("channel-old");

  const replacing = {
    connectionId: oldConnection,
    name: "Support line",
    botId: BotId.make("test-bot"),
    projectId: botProject,
  };

  beforeEach(async () => {
    await act(() =>
      root.render(<ChannelSetupDialog key="replace" {...props} replacing={replacing} />),
    );
  });

  async function enterNewToken() {
    await click("Continue");
    await fill("Telegram Bot token", "new-token");
    await click("Continue");
  }

  it("connects the new credentials before removing the old connection", async () => {
    expect(container.textContent).toContain("Update Telegram credentials");
    await enterNewToken();
    await click("Save and reconnect");
    const newConnection = mocks.save.mock.calls[0]![0].input.connectionId;
    expect(newConnection).not.toBe(oldConnection);
    expect(mocks.save.mock.calls[0]![0].input).toMatchObject({
      name: "Support line",
      token: "new-token",
    });
    expect(mocks.detach).toHaveBeenCalledWith(
      expect.objectContaining({ input: { botId: "test-bot", provider: "telegram" } }),
    );
    expect(mocks.attach.mock.calls.map(([value]) => value.input)).toEqual([
      {
        botId: "test-bot",
        connectionId: newConnection,
        provider: "telegram",
        projectId: botProject,
      },
    ]);
    expect(mocks.deleteConnection.mock.calls.map(([value]) => value.input.connectionId)).toEqual([
      oldConnection,
    ]);
    expect(onSaved).toHaveBeenCalledWith(newConnection);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("puts the old connection back when the new credentials fail", async () => {
    mocks.attach.mockResolvedValueOnce({ _tag: "Failure" });
    await enterNewToken();
    await click("Save and reconnect");
    const newConnection = mocks.save.mock.calls[0]![0].input.connectionId;
    expect(mocks.attach.mock.calls.map(([value]) => value.input.connectionId)).toEqual([
      newConnection,
      oldConnection,
    ]);
    expect(mocks.attach.mock.calls[1]![0].input.projectId).toBe(botProject);
    expect(mocks.deleteConnection.mock.calls.map(([value]) => value.input.connectionId)).toEqual([
      newConnection,
    ]);
    expect(container.textContent).toContain(
      "Could not connect with the new credentials. The old connection is unchanged.",
    );
    expect(onSaved).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(mocks.disconnect).not.toHaveBeenCalled();
  });

  it("keeps a restored channel disconnected when it was disconnected before", async () => {
    await act(() =>
      root.render(
        <ChannelSetupDialog
          key="replace-disconnected"
          {...props}
          replacing={{ ...replacing, disconnected: true }}
        />,
      ),
    );
    mocks.attach.mockResolvedValueOnce({ _tag: "Failure" });
    await enterNewToken();
    await click("Save and reconnect");
    expect(mocks.attach.mock.calls.map(([value]) => value.input.connectionId)).toContain(
      oldConnection,
    );
    expect(mocks.disconnect).toHaveBeenCalledWith(
      expect.objectContaining({ input: { botId: "test-bot", provider: "telegram" } }),
    );
  });

  it("says so when the old connection cannot be restored either", async () => {
    mocks.attach.mockResolvedValue({ _tag: "Failure" });
    await enterNewToken();
    await click("Save and reconnect");
    const newConnection = mocks.save.mock.calls[0]![0].input.connectionId;
    expect(mocks.attach.mock.calls.map(([value]) => value.input.connectionId)).toEqual([
      newConnection,
      oldConnection,
    ]);
    expect(mocks.deleteConnection).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith(newConnection);
    expect(container.textContent).toContain(
      "Could not connect with the new credentials or restore the old connection.",
    );
  });

  // Mirrors the bot's telegram assignment the server reports after the detach.
  async function assignment(connectionId: string | undefined) {
    mocks.snapshot = {
      ...(mocks.snapshot as object),
      bots: [
        {
          id: "test-bot",
          channelBindings: [{ provider: "telegram", status: "disconnected", connectionId }],
        },
      ],
    };
    await act(() =>
      root.render(<ChannelSetupDialog key="replace" {...props} replacing={replacing} />),
    );
  }

  it("leaves the old connection attached when it cannot be detached", async () => {
    await assignment(oldConnection);
    mocks.detach.mockResolvedValueOnce({ _tag: "Failure" });
    await enterNewToken();
    await click("Save and reconnect");
    const newConnection = mocks.save.mock.calls[0]![0].input.connectionId;
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "Could not update the credentials. The old connection is unchanged.",
    );
    expect(onSaved).toHaveBeenCalledWith(newConnection);
    // The snapshot may not have synced the detach yet, so closing keeps the new credentials.
    await act(() => mocks.changeOpen(false));
    expect(mocks.deleteConnection).not.toHaveBeenCalled();
  });

  it("discards the kept connection on retry while the old one stays assigned", async () => {
    await assignment(oldConnection);
    mocks.detach.mockResolvedValueOnce({ _tag: "Failure" });
    await enterNewToken();
    await click("Save and reconnect");
    const kept = mocks.save.mock.calls[0]![0].input.connectionId;
    await click("Save and reconnect");
    const retried = mocks.save.mock.calls[1]![0].input.connectionId;
    expect(retried).not.toBe(kept);
    expect(mocks.detach).toHaveBeenCalledTimes(2);
    expect(mocks.deleteConnection.mock.calls.map(([value]) => value.input.connectionId)).toEqual([
      kept,
      oldConnection,
    ]);
  });

  it("shows the bot unassigned and reconnects when the old listener fails to stop", async () => {
    await assignment(oldConnection);
    // The durable detach removed the connection, then the old listener's shutdown rejected.
    mocks.detach.mockImplementationOnce(async () => {
      await assignment(undefined);

      return { _tag: "Failure" };
    });
    await enterNewToken();
    await click("Save and reconnect");
    const newConnection = mocks.save.mock.calls[0]![0].input.connectionId;
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(mocks.deleteConnection).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith(newConnection);
    expect(container.textContent).toContain(
      "Could not update the credentials, and Test bot is now unassigned from this channel.",
    );
    expect(container.textContent).not.toContain("The old connection is unchanged.");

    await click("Reconnect");
    expect(mocks.detach).toHaveBeenCalledTimes(1);
    expect(mocks.save.mock.calls.map(([value]) => value.input.connectionId)).toEqual([
      newConnection,
      newConnection,
    ]);
    expect(mocks.attach.mock.calls.map(([value]) => value.input)).toEqual([
      {
        botId: "test-bot",
        connectionId: newConnection,
        provider: "telegram",
        projectId: botProject,
      },
    ]);
    expect(mocks.deleteConnection.mock.calls.map(([value]) => value.input.connectionId)).toEqual([
      oldConnection,
    ]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps reconnecting with the kept connection after a failed recovery", async () => {
    await assignment(oldConnection);
    mocks.detach.mockImplementationOnce(async () => {
      await assignment(undefined);

      return { _tag: "Failure" };
    });
    await enterNewToken();
    await click("Save and reconnect");
    const kept = mocks.save.mock.calls[0]![0].input.connectionId;

    mocks.save.mockResolvedValueOnce({ _tag: "Failure" });
    await click("Reconnect");
    expect(container.textContent).toContain("is now unassigned from this channel");
    mocks.attach.mockResolvedValue({ _tag: "Failure" });
    await click("Reconnect");
    expect(container.textContent).toContain(
      "Could not connect with the new credentials or restore the old connection.",
    );
    mocks.attach.mockResolvedValue({ _tag: "Success" });
    await click("Reconnect");

    expect(mocks.detach).toHaveBeenCalledTimes(1);
    expect(mocks.save.mock.calls.map(([value]) => value.input.connectionId)).toEqual([
      kept,
      kept,
      kept,
      kept,
    ]);
    expect(mocks.attach.mock.calls.map(([value]) => value.input.connectionId)).toEqual([
      kept,
      oldConnection,
      kept,
    ]);
    expect(mocks.deleteConnection.mock.calls.map(([value]) => value.input.connectionId)).toEqual([
      oldConnection,
    ]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("follows the assignment when it syncs after the detach failure", async () => {
    await assignment(oldConnection);
    mocks.detach.mockResolvedValueOnce({ _tag: "Failure" });
    await enterNewToken();
    await click("Save and reconnect");
    expect(container.textContent).toContain("The old connection is unchanged.");
    await assignment(undefined);
    expect(container.textContent).toContain("is now unassigned from this channel");
    await act(() => mocks.changeOpen(false));
    expect(mocks.deleteConnection).not.toHaveBeenCalled();
  });
});
