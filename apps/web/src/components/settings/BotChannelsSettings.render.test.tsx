import { Predicate } from "effect";
import { AuthAccessWriteScope, type ChannelBinding } from "@akeru/contracts";
import * as Cause from "effect/Cause";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { BotChannelsSettingsPanel } from "./BotChannelsSettings";
import { fixtureConnection, boundBot, trigger, renderPage } from "./botChannelsRender.test-support";

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
      input: { botId: "bot-uuid", provider: "imessage", expectedConnectionId: "profile-1" },
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
      input: { botId: "bot-uuid", provider: "imessage", expectedConnectionId: "profile-1" },
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

  it("assigns a connection to a bot whose own channel was detached", async () => {
    const { connectionId: _detached, ...detachedBinding } =
      boundBot("disconnected").channelBindings[0]!;

    fixtures.bots = [
      { id: "bot-other", name: "Mira", archivedAt: null, channelBindings: [] },
      { ...boundBot("disconnected"), channelBindings: [detachedBinding] },
    ];
    renderPage();
    fixtures.selects[0]!.onValueChange?.("bot-uuid");
    await fixtures.command.mock.results[0]!.value;
    expect(fixtures.toast).not.toHaveBeenCalled();
    expect(fixtures.command).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: {
        botId: "bot-uuid",
        connectionId: "profile-1",
        provider: "imessage",
        projectId: "project-uuid",
      },
    });
  });

  it("restores a failed move into a live project when the old one was removed", async () => {
    const stale = boundBot("blocked");
    fixtures.bots = [
      {
        ...stale,
        channelBindings: [{ ...stale.channelBindings[0]!, projectId: "project-gone" }],
      },
      { id: "bot-other", name: "Mira", archivedAt: null, channelBindings: [] },
    ];
    fixtures.command
      .mockResolvedValueOnce({ _tag: "Success" })
      .mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail(new Error("rejected")) })
      .mockResolvedValue({ _tag: "Success" });
    renderPage();
    fixtures.selects[0]!.onValueChange?.("bot-other");
    await vi.waitFor(() => expect(fixtures.command).toHaveBeenCalledTimes(4));
    expect(fixtures.command).toHaveBeenNthCalledWith(4, {
      environmentId: "environment-1",
      input: {
        botId: "bot-uuid",
        connectionId: "profile-1",
        projectId: "project-uuid",
        provider: "imessage",
      },
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
