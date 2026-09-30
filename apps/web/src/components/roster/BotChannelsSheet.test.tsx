import { AuthAccessWriteScope, type ChannelBinding } from "@akeru/contracts";
import * as Cause from "effect/Cause";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixtures = vi.hoisted(() => ({
  bots: [] as unknown[],
  projects: [] as Array<{ id: string; title: string; updatedAt: string }>,
  threads: [] as unknown[],
  scopes: [] as string[],
  toast: vi.fn(),
  openSettings: vi.fn(),
  buttons: new Map<string, { onClick?: () => void; disabled?: boolean }>(),
  commands: {
    attach: vi.fn(),
    changeProject: vi.fn(),
    reconnect: vi.fn(),
    disconnect: vi.fn(),
    detach: vi.fn(),
  },
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) =>
    atom === "bots"
      ? fixtures.bots
      : { projects: fixtures.projects, threads: fixtures.threads, bots: fixtures.bots },
}));
vi.mock("../../state/bots", () => ({
  environmentBotsAtom: () => "bots",
  botEnvironment: {
    channels: {
      attach: "attach",
      changeProject: "changeProject",
      reconnect: "reconnect",
      disconnect: "disconnect",
      detach: "detach",
    },
  },
}));
vi.mock("../../state/shell", () => ({ environmentSnapshotAtom: () => "snapshot" }));
vi.mock("../../state/environments", () => ({ usePrimaryEnvironmentId: () => "environment-1" }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: keyof typeof fixtures.commands) => fixtures.commands[command],
}));
vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: () => [
    { id: "profile-1", name: "Fixture line", provider: "telegram", externalIdentity: null },
  ],
}));
vi.mock("../../settingsDialogStore", () => ({
  openSettings: fixtures.openSettings,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: fixtures.toast } }));
vi.mock("../../state/session", () => ({
  useEnvironmentSessionState: () => ({
    isPending: false,
    data: { authenticated: true, scopes: fixtures.scopes },
  }),
}));
vi.mock("../ui/sheet", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Sheet: Pass,
    SheetDescription: Pass,
    SheetFooter: Pass,
    SheetHeader: Pass,
    SheetPanel: Pass,
    SheetPopup: Pass,
    SheetTitle: Pass,
  };
});
vi.mock("../ui/button", () => ({
  Button: (props: { children: ReactNode; onClick?: () => void; disabled?: boolean }) => {
    if (typeof props.children === "string") fixtures.buttons.set(props.children, props);
    return <button disabled={props.disabled}>{props.children}</button>;
  },
}));

import { BotChannelsSheet } from "./BotChannelsSheet";

const bot = { id: "bot-1", name: "Akeru" } as Parameters<typeof BotChannelsSheet>[0]["bot"];

function binding(
  status: ChannelBinding["status"],
  failureCategory?: ChannelBinding["failureCategory"],
) {
  return {
    ...(failureCategory ? { failureCategory, lastError: "Fixed server copy." } : {}),
    botId: "bot-1",
    connectionId: "profile-1",
    provider: "telegram",
    projectId: "project-1",
    status,
    externalIdentity: null,
    connectedAt: null,
    sentMessageIds: [],
  };
}

function render() {
  return renderToStaticMarkup(<BotChannelsSheet bot={bot} open onOpenChange={() => {}} />);
}

describe("BotChannelsSheet project selection", () => {
  beforeEach(() => {
    fixtures.buttons.clear();
    fixtures.scopes = [AuthAccessWriteScope];
    fixtures.toast.mockReset();
    fixtures.openSettings.mockReset();
    for (const command of Object.values(fixtures.commands)) {
      command.mockReset().mockResolvedValue({ _tag: "Success" });
    }
    fixtures.bots = [];
    fixtures.threads = [];
    fixtures.projects = [
      { id: "project-1", title: "First", updatedAt: "2026-09-01T00:00:00.000Z" },
      { id: "project-2", title: "Second", updatedAt: "2026-09-02T00:00:00.000Z" },
    ];
  });

  it("connects an unassigned channel to the preselected live project", () => {
    const html = render();
    expect(html).toContain(">Second<");
    fixtures.buttons.get("Connect")?.onClick?.();
    expect(fixtures.commands.attach).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: {
        botId: "bot-1",
        provider: "telegram",
        connectionId: "profile-1",
        projectId: "project-2",
      },
    });
  });

  it("disables Connect and explains why when no project is live", () => {
    fixtures.projects = [];
    const html = render();
    expect(html).toContain("Add a project before connecting a channel.");
    expect(fixtures.buttons.get("Connect")?.disabled).toBe(true);
  });

  it("repairs a blocked channel in the picked project through change-project", () => {
    fixtures.bots = [{ id: "bot-1", name: "Akeru", channelBindings: [binding("blocked")] }];
    const html = render();
    expect(html).toContain("Choose another project");
    expect(html).toContain(
      "The project for this channel is unavailable. Choose another project to reconnect it.",
    );
    const repair = fixtures.buttons.get("Reconnect in this project");
    expect(repair?.disabled).toBe(false);
    repair?.onClick?.();
    expect(fixtures.commands.changeProject).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: { botId: "bot-1", provider: "telegram", projectId: "project-2" },
    });
    expect(fixtures.commands.reconnect).not.toHaveBeenCalled();
  });

  it("keeps Disconnect for a healthy channel running in its own project", () => {
    fixtures.bots = [{ id: "bot-1", name: "Akeru", channelBindings: [binding("connected")] }];
    const html = render();
    expect(html).toContain(">First<");
    expect(html).not.toContain("Move to this project");
    fixtures.buttons.get("Disconnect")?.onClick?.();
    expect(fixtures.commands.disconnect).toHaveBeenCalledTimes(1);
    expect(fixtures.commands.changeProject).not.toHaveBeenCalled();
  });
});

describe("BotChannelsSheet health and repair", () => {
  beforeEach(() => {
    fixtures.buttons.clear();
    fixtures.scopes = [AuthAccessWriteScope];
    fixtures.toast.mockReset();
    fixtures.openSettings.mockReset();
    for (const command of Object.values(fixtures.commands)) {
      command.mockReset().mockResolvedValue({ _tag: "Success" });
    }
    fixtures.threads = [];
    fixtures.projects = [
      { id: "project-1", title: "First", updatedAt: "2026-09-01T00:00:00.000Z" },
    ];
  });

  const own = (status: ChannelBinding["status"], category?: ChannelBinding["failureCategory"]) => {
    fixtures.bots = [{ id: "bot-1", name: "Akeru", channelBindings: [binding(status, category)] }];
  };

  it("waits on a connecting channel", () => {
    own("connecting");
    const html = render();
    expect(html).toContain(">Connecting…<");
    expect(fixtures.buttons.get("Connecting…")?.disabled).toBe(true);
    expect(fixtures.buttons.has("Disconnect")).toBe(false);
    expect(fixtures.buttons.has("Reconnect")).toBe(false);
  });

  it("sends a connected channel with rejected credentials to Settings", () => {
    own("connected", "credentials");
    const html = render();
    expect(html).toContain("Needs attention · Akeru");
    expect(html).toContain("Telegram rejected the bot token.");
    expect(html).not.toContain("Fixed server copy.");
    expect(fixtures.buttons.has("Disconnect")).toBe(true);
    fixtures.buttons.get("Update credentials")?.onClick?.();
    expect(fixtures.openSettings).toHaveBeenCalledWith(
      "channels",
      "channel-telegram",
      "environment-1",
    );
    expect(fixtures.commands.reconnect).not.toHaveBeenCalled();
  });

  it.each([
    ["connected", "network"],
    ["connected", "restore"],
    ["failed", "network"],
    ["needs-reconnect", undefined],
  ] as const)("reconnects a %s channel with %s failure", (status, category) => {
    own(status, category);
    render();
    fixtures.buttons.get("Reconnect")?.onClick?.();
    expect(fixtures.commands.reconnect).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: { botId: "bot-1", provider: "telegram" },
    });
  });

  it("connects a disconnected channel through reconnect, not attach", () => {
    own("disconnected");
    render();
    fixtures.buttons.get("Connect")?.onClick?.();
    expect(fixtures.commands.reconnect).toHaveBeenCalledTimes(1);
    expect(fixtures.commands.attach).not.toHaveBeenCalled();
  });

  it("offers no repair when delivery is unknown and the provider has no console", () => {
    own("connected", "delivery-unknown");
    render();
    for (const label of ["Reconnect", "Update credentials", "Connect", "Check the channel"]) {
      expect(fixtures.buttons.has(label)).toBe(false);
    }
  });

  it("shows another bot's channel as assigned", () => {
    fixtures.bots = [{ id: "bot-2", name: "Other", channelBindings: [binding("connected")] }];
    const html = render();
    expect(html).toContain("Assigned to Other");
    expect(fixtures.buttons.get("Assigned")?.disabled).toBe(true);
  });

  it("explains an identity conflict in plain words", async () => {
    fixtures.bots = [];
    fixtures.commands.attach.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(new Error("This channel connection is already connected to another bot.")),
    });
    render();
    fixtures.buttons.get("Connect")?.onClick?.();
    await fixtures.commands.attach.mock.results[0]!.value;
    await Promise.resolve();
    expect(fixtures.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Could not update channel",
      description: "Another bot already uses this account. Unassign it there, then connect again.",
    });
  });

  it("keeps the generic toast for other failures", async () => {
    fixtures.bots = [];
    fixtures.commands.attach.mockResolvedValue({ _tag: "Failure" });
    render();
    fixtures.buttons.get("Connect")?.onClick?.();
    await fixtures.commands.attach.mock.results[0]!.value;
    await Promise.resolve();
    expect(fixtures.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Could not update channel",
    });
  });

  it("hides channels from a client without write access", () => {
    fixtures.scopes = [];
    own("failed", "credentials");
    const html = render();
    expect(html).toContain("Channels are managed on the host");
    expect(html).not.toContain("Fixture line");
  });
});
