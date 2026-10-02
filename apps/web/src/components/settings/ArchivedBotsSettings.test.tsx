import { Predicate } from "effect";
import { BotId, EnvironmentId, type OrchestrationBot } from "@akeru/contracts";
import { Children, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

type ButtonProps = { onClick?: () => void; "aria-label"?: string };

const mocks = vi.hoisted(() => ({
  bots: [] as unknown[],
  buttons: new Map<string, ButtonProps>(),
  restore: vi.fn(async () => ({ _tag: "Success" })),
  delete: vi.fn(async () => ({ _tag: "Success" })),
  confirmed: true,
}));

function textOf(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      Predicate.isString(child)
        ? child
        : isValidElement<{ children?: ReactNode }>(child)
          ? textOf(child.props.children)
          : "",
    )
    .join("")
    .trim();
}

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.bots }));

vi.mock("../../state/bots", () => ({
  environmentBotsAtom: () => "bots",
  botEnvironment: { restore: "restore", delete: "delete" },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "restore" ? mocks.restore : mocks.delete),
}));

vi.mock("../../confirmDialog", () => ({
  requestConfirmDialog: () => Promise.resolve(mocks.confirmed),
}));

vi.mock("../roster/BotAvatarView", () => ({ BotAvatarView: () => null }));

vi.mock("./settingsLayout", () => ({
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

import { ArchivedBotsSection, archivedBots } from "./ArchivedBotsSettings";

const environmentId = EnvironmentId.make("env-1");

const bot = (id: string, archivedAt: string | null) =>
  ({
    id: BotId.make(id),
    name: id,
    archivedAt,
    updatedAt: "2026-09-01T00:00:00.000Z",
    avatar: { kind: "dither", seed: id },
  }) as OrchestrationBot;

function render(): string {
  mocks.buttons.clear();

  return renderToStaticMarkup(<ArchivedBotsSection environmentId={environmentId} />);
}

beforeEach(() => {
  mocks.bots = [];
  mocks.confirmed = true;
  mocks.restore.mockClear();
  mocks.delete.mockClear();
});

describe("archivedBots", () => {
  it("lists archived bots newest first and leaves active bots out", () => {
    const archived = archivedBots([
      bot("active", null),
      bot("older", "2026-08-02T00:00:00.000Z"),
      bot("newer", "2026-08-09T00:00:00.000Z"),
    ]);

    expect(archived.map((entry) => entry.id)).toEqual(["newer", "older"]);
  });
});

describe("ArchivedBotsSection", () => {
  it("renders nothing when no bot is archived", () => {
    mocks.bots = [bot("active", null)];
    expect(render()).toBe("");
  });

  it("shows when each archived bot is deleted and restores or deletes it", async () => {
    mocks.bots = [bot("Mori", "2026-09-20T12:00:00.000Z")];
    const markup = render();

    expect(markup).toContain("Archived bots");
    expect(markup).toContain("Mori");
    expect(markup).toContain("Sep 27, 2026");

    mocks.buttons.get("Restore")?.onClick?.();
    mocks.buttons.get("Delete Mori")?.onClick?.();
    await vi.waitFor(() => expect(mocks.delete).toHaveBeenCalled());

    const call = { environmentId, input: { botId: BotId.make("Mori") } };
    expect(mocks.restore).toHaveBeenCalledWith(call);
    expect(mocks.delete).toHaveBeenCalledWith(call);
  });

  it("does not delete when the confirmation is declined", async () => {
    mocks.confirmed = false;
    mocks.bots = [bot("Mori", "2026-09-20T12:00:00.000Z")];
    render();

    mocks.buttons.get("Delete Mori")?.onClick?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.delete).not.toHaveBeenCalled();
  });
});
