import {
  EnvironmentId,
  type OrchestrationBot,
  type OrchestrationShellSnapshot,
  ThreadId,
} from "@akeru/contracts";
import { Children, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

type ButtonProps = { onClick?: () => void; disabled?: boolean; "aria-label"?: string };

const mocks = vi.hoisted(() => ({
  archive: {
    snapshots: [] as Array<{ environmentId: string; snapshot: unknown }>,
    error: null as string | null,
    isLoading: false,
  },
  bots: [] as unknown[],
  buttons: new Map<string, ButtonProps>(),
  unarchive: vi.fn(async () => true),
  delete: vi.fn(async () => true),
}));

function textOf(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      typeof child === "string"
        ? child
        : isValidElement<{ children?: ReactNode }>(child)
          ? textOf(child.props.children)
          : "",
    )
    .join("")
    .trim();
}

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) => (atom === "bots" ? mocks.bots : []),
}));
vi.mock("../../state/bots", () => ({
  environmentBotsAtom: () => "bots",
  environmentGroupsAtom: () => "groups",
}));
vi.mock("../../lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: () => mocks.archive,
}));
vi.mock("../../hooks/useChatActions", () => ({
  useChatActions: () => ({ unarchive: mocks.unarchive, delete: mocks.delete }),
}));
vi.mock("../../settingsDialogStore", () => ({
  useSettingsEnvironmentId: () => "env-1",
  useSettingsDialogStore: () => null,
  clearSettingsTarget: vi.fn(),
}));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
  SettingsRow: (props: { title: ReactNode; description?: ReactNode; control?: ReactNode }) => (
    <div data-row>
      <h3>{props.title}</h3>
      <p>{props.description}</p>
      {props.control}
    </div>
  ),
}));
vi.mock("../ui/button", () => ({
  Button: (props: ButtonProps & { children: ReactNode }) => {
    mocks.buttons.set(props["aria-label"] ?? textOf(props.children), props);
    return null;
  },
}));

import { ArchivedChatsSettingsPanel } from "./ArchivedChatsSettings";

const environmentId = EnvironmentId.make("env-1");

function render(): string {
  mocks.buttons.clear();
  return renderToStaticMarkup(<ArchivedChatsSettingsPanel />);
}

beforeEach(() => {
  mocks.archive = { snapshots: [], error: null, isLoading: false };
  mocks.bots = [];
  mocks.unarchive.mockClear();
  mocks.delete.mockClear();
});

describe("ArchivedChatsSettingsPanel", () => {
  it("says so when nothing is archived", () => {
    mocks.archive.snapshots = [{ environmentId, snapshot: { threads: [], bots: [], groups: [] } }];
    const markup = render();
    expect(markup).toContain("No archived chats");
    expect(markup).toContain("Chats you archive will appear here.");
  });

  it("reports a failed load instead of an empty archive", () => {
    mocks.archive = { snapshots: [], error: "Failed to load archived chats.", isLoading: false };
    expect(render()).toContain("Could not load archived chats");
  });

  it("keeps cached chats but reports a failed refresh", () => {
    mocks.archive = {
      snapshots: [
        {
          environmentId,
          snapshot: {
            bots: [],
            groups: [],
            threads: [
              {
                id: "thread-1",
                title: "Trip plans",
                createdAt: "2026-09-01T00:00:00.000Z",
                updatedAt: "2026-09-20T00:00:00.000Z",
                archivedAt: "2026-09-20T00:00:00.000Z",
              },
            ],
          } as unknown as OrchestrationShellSnapshot,
        },
      ],
      error: "Failed to load archived chats.",
      isLoading: false,
    };
    const markup = render();
    expect(markup).toContain("Trip plans");
    expect(markup).toContain("Could not load archived chats");
  });

  it("lists archived chats under their bot and restores or deletes them", async () => {
    mocks.bots = [{ id: "bot-mori", name: "Mori" } as OrchestrationBot];
    mocks.archive.snapshots = [
      {
        environmentId,
        snapshot: {
          bots: [],
          groups: [],
          threads: [
            {
              id: "thread-1",
              title: "Trip plans",
              botId: "bot-mori",
              createdAt: "2026-09-01T00:00:00.000Z",
              updatedAt: "2026-09-20T00:00:00.000Z",
              archivedAt: "2026-09-20T00:00:00.000Z",
            },
          ],
        } as unknown as OrchestrationShellSnapshot,
      },
    ];
    const markup = render();

    expect(markup).toContain("<h2>Mori</h2>");
    expect(markup).toContain("Trip plans");
    expect(markup).toContain("Archived ");

    mocks.buttons.get("Unarchive")?.onClick?.();
    mocks.buttons.get("Delete Trip plans")?.onClick?.();
    await Promise.resolve();

    const threadRef = { environmentId, threadId: ThreadId.make("thread-1") };
    expect(mocks.unarchive).toHaveBeenCalledWith(threadRef);
    expect(mocks.delete).toHaveBeenCalledWith(threadRef);
  });
});
