import type { ResolvedKeybindingsConfig } from "@akeru/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@akeru/shared/keybindings";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixtures = vi.hoisted(() => ({
  keybindings: [] as ResolvedKeybindingsConfig,
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) => (atom === "keybindings" ? fixtures.keybindings : null),
}));
vi.mock("../../state/server", () => ({
  primaryServerKeybindingsAtom: "keybindings",
  primaryServerKeybindingsConfigPathAtom: "configPath",
  primaryServerAvailableEditorsAtom: "editors",
  serverEnvironment: {},
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironment: () => ({ environmentId: "environment-1" }),
}));
vi.mock("../../editorPreferences", () => ({ useOpenInPreferredEditor: () => vi.fn() }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("./settingsLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settingsLayout")>()),
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { KeybindingsSettingsPanel } from "./KeybindingsSettings";

function render(): string {
  return renderToStaticMarkup(<KeybindingsSettingsPanel />);
}

describe("KeybindingsSettingsPanel", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    fixtures.keybindings = DEFAULT_RESOLVED_KEYBINDINGS;
  });

  it("renders purpose groups with collapsed numbered series", () => {
    const html = render();

    for (const title of ["General", "Chats", "Composer &amp; models", "Layout"]) {
      expect(html).toContain(`aria-label="${title}"`);
    }
    expect(html).not.toContain('aria-label="Browser preview"');
    expect(html).not.toContain("the terminal is focused");
    expect(html).toContain("Jump to chat 1–9");
    expect(html).toContain("Pick model 1–9");
    expect(html).not.toContain("Jump to chat 4");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Change shortcut for Open command palette, currently ⌘ K");
    expect(html).toContain("Add condition for Open command palette");
    expect(html).not.toContain("Conflicts");
  });

  it("surfaces conflicts with a review action and a filter", () => {
    fixtures.keybindings = [
      ...DEFAULT_RESOLVED_KEYBINDINGS,
      {
        command: "sidebar.toggle",
        shortcut: {
          key: "k",
          modKey: true,
          metaKey: false,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
        },
      },
    ];
    const html = render();

    expect(html).toContain("2 shortcuts share their keys with another command.");
    expect(html).toContain(">Review<");
    expect(html).toContain("Conflicts");
    expect(html).toContain("Conflict. Same keys as Toggle sidebar.");
    expect(html).toContain(">Custom<");
  });
});
