import { Predicate } from "effect";
import { AuthAccessWriteScope, type ChannelBinding } from "@akeru/contracts";
import * as Cause from "effect/Cause";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PhotonModeSelect } from "./ChannelSetupDialog";
import { fixtureConnection, trigger, renderPage } from "./botChannelsRender.test-support";

const fixtures = vi.hoisted(() => ({
  bots: [] as Array<{
    id: string;
    name: string;
    archivedAt: null;
    channelBindings: Array<{
      botId: string;
      connectionId?: string;
      provider: "imessage" | "whatsapp";
      projectId: string;
      status: ChannelBinding["status"];
      lastError?: string;
      failureCategory?: ChannelBinding["failureCategory"];
      externalIdentity: null;
      connectedAt: null;
      sentMessageIds: string[];
    }>;
  }>,
  projects: [
    {
      id: "project-uuid",
      title: "Selected workspace",
      workspaceRoot: "/Users/leo/code/selected",
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
  ] as Array<{ id: string; title: string; workspaceRoot: string; updatedAt: string }>,
  threads: [] as Array<{ projectId: string; botId: string; updatedAt: string; archivedAt: null }>,
  connections: [
    { id: "profile-1", name: "Fixture line", provider: "imessage", externalIdentity: null },
  ] as Array<{
    id: string;
    name: string;
    provider: string;
    externalIdentity: string | null;
    webhookUrl?: string | null;
    managementUrl?: string | null;
  }>,
  scopes: [] as string[],
  selects: [] as Array<{ onValueChange?: (value: string | null) => void }>,
  buttons: new Map<string, () => void>(),
  confirm: vi.fn<(message: string) => Promise<boolean> | undefined>(),
  command: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) =>
    atom === "bots" ? fixtures.bots : { projects: fixtures.projects, threads: fixtures.threads },
}));

vi.mock("../../state/shell", () => ({ environmentSnapshotAtom: () => "snapshot" }));

vi.mock("../../state/bots", () => ({
  environmentBotsAtom: () => "bots",
  botEnvironment: { channels: {} },
}));

vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => fixtures.command }));

vi.mock("../../hooks/useSettings", () => ({ useEnvironmentSettings: () => fixtures.connections }));

vi.mock("../ui/toast", () => ({ toastManager: { add: fixtures.toast } }));

vi.mock("../../settingsDialogStore", () => ({ useSettingsEnvironmentId: () => "environment-1" }));

vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: fixtures.confirm }));

vi.mock("../../state/session", () => ({
  useEnvironmentSessionState: () => ({
    isPending: false,
    data: { authenticated: true, scopes: fixtures.scopes },
  }),
}));

vi.mock("../ui/select", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ui/select")>();

  return {
    ...actual,
    Select: (props: Parameters<typeof actual.Select>[0]) => {
      fixtures.selects.push(props as (typeof fixtures.selects)[number]);

      return <actual.Select {...props} />;
    },
  };
});

vi.mock("../ui/button", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ui/button")>();

  return {
    ...actual,
    Button: (props: Parameters<typeof actual.Button>[0]) => {
      if (Predicate.isString(props.children) && props.onClick) {
        const onClick = props.onClick;
        fixtures.buttons.set(props.children, () => onClick({} as never));
      }

      return <actual.Button {...props} />;
    },
  };
});

// The row's overflow menu renders inline, so static markup shows its items and tests can click them.
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MenuTrigger: () => null,
  MenuPopup: ({ children }: { children: ReactNode }) => <div role="menu">{children}</div>,
  MenuSeparator: () => <hr />,
  MenuItem: ({
    children,
    disabled,
    onClick,
    render,
  }: {
    children: string;
    disabled?: boolean;
    onClick?: () => void;
    render?: ReactElement<{ children?: ReactNode }>;
  }) => {
    if (onClick) fixtures.buttons.set(children, onClick);

    if (render) return cloneElement(render, {}, children);

    return (
      <button type="button" disabled={disabled}>
        {children}
      </button>
    );
  },
}));

vi.mock("./settingsLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settingsLayout")>()),
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("./settingsDetailLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settingsDetailLayout")>()),
  SettingsDetailHeader: ({ title, statusLabel }: { title: string; statusLabel: string }) => (
    <header>
      {title} {statusLabel}
    </header>
  ),
  SettingsLinkRow: ({ title, statusLabel }: { title: string; statusLabel: string }) => (
    <a data-settings-row="">
      {title}: {statusLabel}
    </a>
  ),
}));

const liveProject = fixtures.projects[0]!;

beforeEach(() => {
  fixtures.bots = [];
  fixtures.projects = [liveProject];
  fixtures.threads = [];
  fixtures.connections = [fixtureConnection];
  fixtures.selects = [];
  fixtures.buttons = new Map();
  fixtures.scopes = [AuthAccessWriteScope];
  fixtures.command.mockReset().mockResolvedValue({ _tag: "Success" });
  fixtures.toast.mockReset();
  fixtures.confirm.mockReset();
});

describe("channel identity conflicts", () => {
  it("explains that another bot already uses the account", async () => {
    fixtures.command.mockReset().mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(new Error("This channel connection is attached to another bot.")),
    });
    renderPage();
    fixtures.selects[0]!.onValueChange?.("bot-uuid");
    await fixtures.command.mock.results[0]!.value;
    await Promise.resolve();
    expect(fixtures.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Could not assign channel",
      description: "Another bot already uses this account. Unassign it there, then connect again.",
    });
  });
});

describe("Photon connection type", () => {
  it("shows the option label in the trigger", () => {
    const html = renderToStaticMarkup(<PhotonModeSelect mode="hosted" onChange={() => {}} />);
    expect(trigger(html, "Photon connection type")).toBeDefined();
    expect(html).toContain(">Photon hosted<");
    expect(html).not.toContain(">hosted<");
  });
});
