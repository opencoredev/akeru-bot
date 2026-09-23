// @effect-diagnostics nodeBuiltinImport:off - The submit guard reads its source.
import * as NodeFS from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  environmentId: "env-1" as string | null,
  createBot: vi.fn(),
}));

vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => testState.environmentId,
}));
vi.mock("../../state/bots", () => ({ botEnvironment: { create: "create-bot-atom" } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => testState.createBot }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import { BotZeroState } from "./BotZeroState";

beforeEach(() => {
  testState.environmentId = "env-1";
  testState.createBot = vi.fn(() => new Promise(() => {}));
});

describe("BotZeroState", () => {
  it("explains what a bot is and offers to create one", () => {
    const markup = renderToStaticMarkup(<BotZeroState />);

    expect(markup).toContain("Create your first bot");
    expect(markup).toContain("A bot is a teammate you chat with.");
    expect(markup).toContain(">Create bot</button>");
    expect(markup).not.toContain("Create a bot to start chatting");
  });

  it("says why it cannot create a bot without an environment", () => {
    testState.environmentId = null;
    const markup = renderToStaticMarkup(<BotZeroState />);

    expect(markup).toContain("Connect an environment to create one.");
    expect(markup).toContain("disabled");
  });
});

/*
 * The dialog renders through a portal, so its markup is empty to
 * renderToStaticMarkup and there is no DOM in this project to mount it into.
 * The duplicate-submit guard is therefore asserted at the source level, on both
 * halves of the path: the caller that must not fire twice, and the form that
 * must not accept a second submit.
 */
describe("duplicate submit guard", () => {
  it("refuses a second create while the first is still in flight", () => {
    const source = NodeFS.readFileSync(new URL("./BotZeroState.tsx", import.meta.url), "utf8");

    expect(source).toContain("if (creating) return;");
    expect(source).toContain("submitting={creating}");
    // Closing mid-flight would strand the in-flight create behind a shut dialog.
    expect(source).toContain("if (creating) return;\n            setOpen(next);");
  });

  it("ignores a submit raised while the dialog is already submitting", () => {
    const source = NodeFS.readFileSync(new URL("./NewBotDialog.tsx", import.meta.url), "utf8");

    expect(source).toContain("if (submitting || trimmedName.length === 0) return;");
    expect(source).toContain("disabled={submitting || trimmedName.length === 0}");
    expect(source).toContain('{submitting ? "Creating" : "Create bot"}');
    // Cancel is disabled too, so the dialog cannot be dismissed mid-create.
    expect(source).toContain("disabled={submitting}");
  });
});
