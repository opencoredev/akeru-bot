import { Predicate } from "effect";
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
  snapshot: null as {
    bots?: readonly { id: string; title: string }[];
    projects: Array<{ id: string; title: string; workspaceRoot?: string; updatedAt: string }>;
    threads: Array<{
      projectId: string;
      botId: string;
      updatedAt: string;
      archivedAt: string | null;
    }>;
  } | null,
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

let container: Element;

const onSaved = vi.fn();

const onOpenChange = vi.fn();

const props = createChannelSetupProps(onSaved, onOpenChange);

const { click, completeSetup } = createChannelSetupActions(mocks);

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
  container = globalThis.document.createElement("div");
  const { createRoot } = await import("react-dom/client");
  root = createRoot(container);
  await act(() => root.render(<ChannelSetupDialog {...props} />));
});

afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("ChannelSetupDialog project selection", () => {
  it("preselects the bot's recent project and attaches to the project the user picks", async () => {
    await completeSetup();
    expect(mocks.projectSelect?.value).toBe(botProject);
    await act(() => mocks.projectSelect?.onChange(firstProject));
    expect(mocks.projectSelect?.value).toBe(firstProject);
    await click("Connect");
    expect(mocks.attach.mock.calls[0]![0].input.projectId).toBe(firstProject);
  });

  it("keeps Connect disabled when no project is live", async () => {
    mocks.snapshot = { projects: [], threads: [] };
    await act(() => root.render(<ChannelSetupDialog {...props} open={false} />));
    await act(() => root.render(<ChannelSetupDialog {...props} />));
    await completeSetup();
    expect(mocks.projectSelect?.projects).toEqual([]);
    expect(mocks.projectSelect?.value).toBeNull();
    expect(mocks.buttons.get("Connect")?.disabled).toBe(true);
    expect(mocks.attach).not.toHaveBeenCalled();
  });
});
