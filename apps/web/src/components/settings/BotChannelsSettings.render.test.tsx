import { AuthAccessWriteScope, type ChannelBinding } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixtures = vi.hoisted(() => ({
  bots: [] as Array<{
    id: string;
    name: string;
    archivedAt: null;
    channelBindings: Array<{
      botId: string;
      connectionId: string;
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
  ] as Array<Record<string, unknown>>,
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
      if (typeof props.children === "string" && props.onClick) {
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

import { channelFailureReason } from "@t3tools/client-runtime/channel-presentation";
import type { ChannelConnectionProfile } from "@t3tools/contracts";

import { BotChannelsSettingsPanel, useChannelSettings } from "./BotChannelsSettings";
import { ChannelConnectionRow, ChannelDetailPage } from "./ChannelDetailPage";
import { PhotonModeSelect } from "./ChannelSetupDialog";

const liveProject = fixtures.projects[0]!;
const fixtureConnection = {
  id: "profile-1",
  name: "Fixture line",
  provider: "imessage",
  externalIdentity: null,
};

function boundBot(
  status: ChannelBinding["status"],
  lastError?: string,
  failureCategory?: ChannelBinding["failureCategory"],
  provider: "imessage" | "whatsapp" = "imessage",
) {
  return {
    id: "bot-uuid",
    name: "Akeru",
    archivedAt: null,
    channelBindings: [
      {
        botId: "bot-uuid",
        connectionId: "profile-1",
        provider,
        projectId: "project-uuid",
        status,
        ...(lastError ? { lastError } : {}),
        ...(failureCategory ? { failureCategory } : {}),
        externalIdentity: null,
        connectedAt: null,
        sentMessageIds: [],
      },
    ],
  };
}

function trigger(html: string, label: string) {
  return html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0];
}

function button(html: string, label: string) {
  return html.match(new RegExp(`<(?:button|a)[^>]*>${label}</(?:button|a)>`))?.[0];
}

const renderPage = (provider: "imessage" | "whatsapp" = "imessage") =>
  renderToStaticMarkup(<ChannelDetailPage provider={provider} />);

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

describe("channel overview", () => {
  it("lists every channel kind with its status", () => {
    const html = renderToStaticMarkup(<BotChannelsSettingsPanel />);
    expect(html).toContain("iMessage: 1 connection");
    expect(html).toContain("Telegram: Not set up");
    expect(html).toContain("Discord: Not set up");
    expect(html).not.toContain("Choose a bot");
  });

  it("flags a channel whose connection needs a new project", () => {
    fixtures.bots = [boundBot("blocked")];
    const html = renderToStaticMarkup(<BotChannelsSettingsPanel />);
    expect(html).toContain("iMessage: Needs attention");
  });
});

describe("channel project selection", () => {
  it("preselects a live project for an unassigned connection and allows assignment", () => {
    const html = renderPage();
    expect(html).toContain("Bot that answers");
    expect(html).toContain("Choose a bot");
    expect(html).toContain(">Selected workspace<");
    expect(html).not.toContain("/Users/leo/code/selected");
    expect(trigger(html, "Project for Fixture line")).toBeDefined();
    const assign = trigger(html, "Assign Fixture line");
    expect(assign).toBeDefined();
    expect(assign).not.toMatch(/\sdisabled(=|\s|>)/);
  });

  it("attaches with the picked project", async () => {
    fixtures.bots = [{ id: "bot-other", name: "Mira", archivedAt: null, channelBindings: [] }];
    renderPage();
    fixtures.selects[0]!.onValueChange?.("bot-other");
    await fixtures.command.mock.results[0]!.value;
    expect(fixtures.command).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: {
        botId: "bot-other",
        connectionId: "profile-1",
        provider: "imessage",
        projectId: "project-uuid",
      },
    });
  });

  it("uses the destination bot's recent project when changing an existing assignment", async () => {
    fixtures.projects = [
      liveProject,
      {
        id: "project-other",
        title: "Mira's workspace",
        workspaceRoot: "/Users/leo/code/other",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    ];
    fixtures.bots = [
      boundBot("connected"),
      { id: "bot-other", name: "Mira", archivedAt: null, channelBindings: [] },
    ];
    fixtures.threads = [
      {
        projectId: "project-other",
        botId: "bot-other",
        updatedAt: "2026-09-02T00:00:00.000Z",
        archivedAt: null,
      },
    ];

    renderPage();
    fixtures.selects[0]!.onValueChange?.("bot-other");
    await fixtures.command.mock.results[0]!.value;
    await fixtures.command.mock.results[1]!.value;

    expect(fixtures.command).toHaveBeenNthCalledWith(1, {
      environmentId: "environment-1",
      input: { botId: "bot-uuid", provider: "imessage" },
    });
    expect(fixtures.command).toHaveBeenNthCalledWith(2, {
      environmentId: "environment-1",
      input: {
        botId: "bot-other",
        connectionId: "profile-1",
        provider: "imessage",
        projectId: "project-other",
      },
    });
  });

  it("shows an empty state and blocks assignment when no project is live", () => {
    fixtures.projects = [];
    const html = renderPage();
    expect(html).toContain("Add a project before connecting a channel.");
    expect(trigger(html, "Project for Fixture line")).toBeUndefined();
    expect(trigger(html, "Assign Fixture line")).toMatch(/\sdisabled(=|\s|>)/);
  });

  it("still unassigns a channel when no project is live", async () => {
    fixtures.bots = [boundBot("blocked")];
    fixtures.projects = [];
    const html = renderPage();
    expect(html).toContain("Add a project before connecting a channel.");
    expect(trigger(html, "Assign Fixture line")).not.toMatch(/\sdisabled(=|\s|>)/);
    // The assignment picker is the only Select on the row while the project picker is empty.
    expect(fixtures.selects).toHaveLength(1);
    fixtures.selects[0]!.onValueChange?.("unassigned");
    await fixtures.command.mock.results[0]!.value;
    expect(fixtures.command).toHaveBeenCalledTimes(1);
    expect(fixtures.command).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: { botId: "bot-uuid", provider: "imessage" },
    });
  });

  it("keeps both bindings when the destination already has this channel provider", () => {
    fixtures.bots = [
      boundBot("connected"),
      {
        ...boundBot("connected"),
        id: "bot-other",
        name: "Mira",
        channelBindings: [
          {
            ...boundBot("connected").channelBindings[0]!,
            botId: "bot-other",
            connectionId: "profile-2",
          },
        ],
      },
    ];
    renderPage();
    fixtures.selects[0]!.onValueChange?.("bot-other");
    expect(fixtures.command).not.toHaveBeenCalled();
    expect(fixtures.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Unassign the channel already connected to this bot first",
    });
  });

  it("renders a blocked binding with repair copy and a project repair action", () => {
    fixtures.bots = [boundBot("blocked", "private-server-detail")];
    const html = renderPage();
    expect(html).toContain("Choose another project");
    expect(html).toContain(
      "The project for this channel is unavailable. Choose another project to reconnect it.",
    );
    expect(html).toContain("Reconnect in this project");
    expect(html).not.toContain(">Reconnect<");
    expect(html).not.toContain("private-server-detail");
  });

  it("asks for a project when the bound project was removed", () => {
    fixtures.bots = [boundBot("connected")];
    fixtures.projects = [{ ...liveProject, id: "project-other", title: "Other workspace" }];
    const html = renderPage();
    expect(html).toContain("Choose another project");
    expect(html).toContain(">Other workspace<");
    expect(html).toContain("Reconnect in this project");
  });

  it("does not offer a move while the running project is selected", () => {
    fixtures.bots = [boundBot("connected")];
    const html = renderPage();
    expect(html).toContain("Assigned to Akeru");
    expect(html).not.toContain("Move to this project");
    expect(html).not.toContain("Reconnect in this project");
  });

  it("renders the assigned project and bot names rather than their IDs", () => {
    fixtures.bots = [
      boundBot(
        "disconnected",
        "Delivery could not be confirmed. Check the external conversation before retrying.",
      ),
    ];
    const html = renderPage();
    expect(html).toContain(">Akeru<");
    expect(html).toContain(">Selected workspace<");
    expect(html).not.toContain(">project-uuid<");
    expect(html).not.toContain(">bot-uuid<");
    expect(html).toContain('role="status"');
    expect(html).toContain(
      "Delivery could not be confirmed. Check the external conversation before retrying.",
    );
  });
});

describe("channel health and repair", () => {
  it("shows a still connecting channel without a repair action", () => {
    fixtures.bots = [boundBot("connecting")];
    const html = renderPage();
    expect(html).toContain(">Connecting…<");
    expect(button(html, "Connecting…")).toMatch(/\sdisabled(=|\s|>)/);
    expect(button(html, "Reconnect")).toBeUndefined();
    expect(button(html, "Disconnect")).toBeUndefined();
  });

  it("explains a not live channel and shows the webhook URL from the profile", () => {
    fixtures.connections = [
      {
        ...fixtureConnection,
        provider: "whatsapp",
        webhookUrl: "https://akeru.example.com/channels/whatsapp/hook",
      },
    ];
    fixtures.bots = [boundBot("not-live", undefined, undefined, "whatsapp")];
    const html = renderPage("whatsapp");
    expect(html).toContain(">Not live<");
    expect(html).toContain("WhatsApp needs a public HTTPS address to receive messages.");
    expect(html).toContain("https://akeru.example.com/channels/whatsapp/hook");
    expect(button(html, "Reconnect")).toBeUndefined();
    expect(button(html, "Connect")).toBeUndefined();
  });

  it("omits the webhook line when the profile has no webhook URL", () => {
    fixtures.bots = [boundBot("not-live")];
    const html = renderPage();
    expect(html).toContain(">Not live<");
    expect(html).not.toContain("Webhook URL");
  });

  it("shows the saved webhook URL for a connected WhatsApp channel", () => {
    fixtures.connections = [
      {
        ...fixtureConnection,
        provider: "whatsapp",
        webhookUrl: "https://akeru.example.com/channels/whatsapp/hook",
      },
    ];
    fixtures.bots = [boundBot("connected", undefined, undefined, "whatsapp")];
    const html = renderPage("whatsapp");
    expect(html).toContain(">Assigned to Akeru<");
    expect(html).toContain("Webhook URL");
    expect(html).toContain("https://akeru.example.com/channels/whatsapp/hook");
  });

  it("does not show a webhook URL for a connected non-WhatsApp channel", () => {
    fixtures.connections = [
      { ...fixtureConnection, webhookUrl: "https://akeru.example.com/not-whatsapp" },
    ];
    fixtures.bots = [boundBot("connected")];
    const html = renderPage();
    expect(html).not.toContain("Webhook URL");
    expect(html).not.toContain("https://akeru.example.com/not-whatsapp");
  });

  it.each([
    ["failed", "credentials", "Connection failed", "Update credentials"],
    ["failed", "network", "Connection failed", "Reconnect"],
    ["needs-reconnect", undefined, "Needs reconnect", "Reconnect"],
    ["disconnected", undefined, "Disconnected · Akeru", "Connect"],
    ["connected", "credentials", "Needs attention · Akeru", "Update credentials"],
    ["connected", "network", "Needs attention · Akeru", "Reconnect"],
    ["connected", "restore", "Needs attention · Akeru", "Reconnect"],
  ] as const)("%s with %s failure shows one %s repair", (status, category, badge, repair) => {
    fixtures.bots = [boundBot(status, category ? "Fixed server copy." : undefined, category)];
    const html = renderPage();
    expect(html).toContain(`>${badge}<`);
    expect(button(html, repair)).toBeDefined();
    expect(button(html, repair)).not.toMatch(/\sdisabled(=|\s|>)/);
    const repairs = ["Connect", "Reconnect", "Update credentials", "Reconnect in this project"];
    expect(repairs.filter((label) => button(html, label))).toEqual([repair]);
    if (category) {
      expect(html).toContain(channelFailureReason(category, "imessage"));
      expect(html).not.toContain("Fixed server copy.");
    }
  });

  it("reconnects through the repair button", async () => {
    fixtures.bots = [boundBot("needs-reconnect")];
    renderPage();
    fixtures.buttons.get("Reconnect")?.();
    await fixtures.command.mock.results[0]!.value;
    expect(fixtures.command).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: { botId: "bot-uuid", provider: "imessage" },
    });
  });

  it("opens the credential replacement for the assigned bot and project", () => {
    fixtures.bots = [boundBot("failed", "Fixed server copy.", "credentials")];
    const replace = vi.fn();
    function Row() {
      const settings = useChannelSettings("environment-1" as never);
      return (
        <ChannelConnectionRow
          connection={fixtureConnection as unknown as ChannelConnectionProfile}
          settings={settings}
          onReplaceCredentials={replace}
        />
      );
    }
    renderToStaticMarkup(<Row />);
    fixtures.buttons.get("Update credentials")?.();
    expect(replace).toHaveBeenCalledWith({
      connectionId: "profile-1",
      name: "Fixture line",
      botId: "bot-uuid",
      projectId: "project-uuid",
    });
    expect(fixtures.command).not.toHaveBeenCalled();
  });

  it("links a connected channel with unknown delivery to the provider console", () => {
    fixtures.connections = [
      { ...fixtureConnection, managementUrl: "https://provider.example.com/console" },
    ];
    fixtures.bots = [
      boundBot(
        "connected",
        "Delivery could not be confirmed. Check the external conversation before retrying.",
        "delivery-unknown",
      ),
    ];
    const html = renderPage();
    expect(html).toContain(">Needs attention · Akeru<");
    expect(button(html, "Check the channel")).toContain(
      'href="https://provider.example.com/console"',
    );
    expect(button(html, "Open provider")).toBeUndefined();
    expect(button(html, "Reconnect")).toBeUndefined();
    expect(button(html, "Disconnect")).toBeDefined();
  });

  it("shows no repair for a healthy connected channel", () => {
    fixtures.bots = [boundBot("connected")];
    const html = renderPage();
    expect(html).toContain(">Assigned to Akeru<");
    expect(html).not.toContain('role="status"');
    expect(button(html, "Disconnect")).toBeDefined();
    for (const label of ["Connect", "Reconnect", "Update credentials", "Check the channel"]) {
      expect(button(html, label)).toBeUndefined();
    }
  });

  it("hides channel management from a client without write access", () => {
    fixtures.scopes = [];
    fixtures.bots = [boundBot("failed", "Fixed server copy.", "credentials")];
    const html = renderPage();
    expect(html).toContain("This client does not have permission to manage channels.");
    expect(html).not.toContain("Fixture line");
    expect(html).not.toContain("Update credentials");
  });
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

describe("failed channel attempts", () => {
  it("keeps the chosen bot on a connection that failed to attach", () => {
    fixtures.bots = [boundBot("failed", "Fixed server copy.", "credentials")];
    const html = renderPage();
    expect(trigger(html, "Assign Fixture line")).toBeDefined();
    expect(html).toContain(">Akeru<");
    expect(html).not.toContain("Choose a bot");
    expect(html).not.toContain(">Unassigned<");
    expect(html).toContain("Photon rejected the connection credentials.");
  });

  it("releases the new bot before giving the connection back to the previous one", async () => {
    fixtures.bots = [
      boundBot("connected"),
      { id: "bot-other", name: "Mira", archivedAt: null, channelBindings: [] },
    ];
    fixtures.command.mockReset().mockImplementation(async (value: { input: object }) =>
      "connectionId" in value.input && "botId" in value.input && value.input.botId === "bot-other"
        ? {
            _tag: "Failure",
            cause: Cause.fail({
              message: "The channel credentials were rejected.",
              channelFailureCategory: "credentials",
            }),
          }
        : { _tag: "Success" },
    );
    const toasted = new Promise<void>((resolve) => {
      fixtures.toast.mockImplementationOnce(() => resolve());
    });
    renderPage();
    fixtures.selects[0]!.onValueChange?.("bot-other");
    await toasted;
    expect(fixtures.command.mock.calls.map(([value]) => value.input)).toEqual([
      { botId: "bot-uuid", provider: "imessage" },
      expect.objectContaining({ botId: "bot-other", connectionId: "profile-1" }),
      { botId: "bot-other", provider: "imessage" },
      expect.objectContaining({ botId: "bot-uuid", connectionId: "profile-1" }),
    ]);
    expect(fixtures.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Could not assign channel",
      description: "Photon rejected the connection credentials.",
    });
  });

  it("asks before deleting a connection", async () => {
    // The page awaits the answer before the test does, so it has acted once the test resumes.
    const declined = Promise.resolve(false);
    fixtures.confirm.mockReturnValueOnce(declined);
    renderPage();
    fixtures.buttons.get("Delete")?.();
    expect(fixtures.confirm).toHaveBeenCalledWith(
      "Delete Fixture line? Its saved credentials are removed from this environment.",
      { variant: "destructive", confirmLabel: "Delete" },
    );
    await declined;
    expect(fixtures.command).not.toHaveBeenCalled();

    const accepted = Promise.resolve(true);
    fixtures.confirm.mockReturnValueOnce(accepted);
    fixtures.buttons.get("Delete")?.();
    await accepted;
    expect(fixtures.command).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: { connectionId: "profile-1" },
    });
  });

  it("explains how to enable Delete for an assigned connection", () => {
    fixtures.bots = [boundBot("connected")];
    const assigned = renderPage();
    expect(assigned).toContain("Choose No bot to delete this connection.");
    expect(assigned).toMatch(/<button[^>]*disabled=""[^>]*>Delete<\/button>/);

    fixtures.bots = [];
    const unassigned = renderPage();
    expect(unassigned).not.toContain("Choose No bot to delete this connection.");
    expect(unassigned).not.toMatch(/<button[^>]*disabled=""[^>]*>Delete<\/button>/);
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
