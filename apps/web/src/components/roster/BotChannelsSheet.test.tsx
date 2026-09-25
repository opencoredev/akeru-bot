import { AuthAccessWriteScope } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixtures = vi.hoisted(() => ({
  bots: [] as unknown[],
  projects: [] as Array<{ id: string; title: string; updatedAt: string }>,
  threads: [] as unknown[],
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
vi.mock("../../settingsDialogStore", () => ({ openSettings: vi.fn() }));
vi.mock("../../state/session", () => ({
  useEnvironmentSessionState: () => ({
    isPending: false,
    data: { authenticated: true, scopes: [AuthAccessWriteScope] },
  }),
}));
vi.mock("../ui/sheet", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return { Sheet: Pass, SheetHeader: Pass, SheetPanel: Pass, SheetPopup: Pass, SheetTitle: Pass };
});
vi.mock("../ui/button", () => ({
  Button: (props: { children: ReactNode; onClick?: () => void; disabled?: boolean }) => {
    if (typeof props.children === "string") fixtures.buttons.set(props.children, props);
    return <button disabled={props.disabled}>{props.children}</button>;
  },
}));

import { BotChannelsSheet } from "./BotChannelsSheet";

const bot = { id: "bot-1", name: "Akeru" } as Parameters<typeof BotChannelsSheet>[0]["bot"];

function binding(status: "blocked" | "connected") {
  return {
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
