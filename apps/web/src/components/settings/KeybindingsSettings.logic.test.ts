import { describe, expect, it } from "vite-plus/test";
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";

import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";

import {
  buildKeybindingGroups,
  buildKeybindingRows,
  buildKeybindingCommandOptions,
  buildWhenVariableOptions,
  commandLabel,
  describeWhenExpression,
  keybindingConflictLabels,
  keybindingDisplayParts,
  keybindingFromKeyboardEvent,
  keybindingGroupForCommand,
  parseWhenExpressionDraft,
  shortcutToKeybindingInput,
  summarizeKeybindings,
  unknownWhenVariables,
  whenAstToExpression,
} from "./KeybindingsSettings.logic";

function shortcut(key: string, modifiers: { shift?: boolean; alt?: boolean } = {}) {
  return {
    key,
    modKey: true,
    metaKey: false,
    ctrlKey: false,
    altKey: modifiers.alt ?? false,
    shiftKey: modifiers.shift ?? false,
  };
}

describe("KeybindingsSettings.logic", () => {
  it("builds searchable rows with readable key and when values", () => {
    const rows = buildKeybindingRows(
      [
        {
          command: "sidebar.toggle",
          shortcut: {
            key: "b",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
          },
          whenAst: {
            type: "not",
            node: { type: "identifier", name: "terminalFocus" },
          },
        },
      ] satisfies ResolvedKeybindingsConfig,
      "sidebar",
    );

    expect(rows).toEqual([
      expect.objectContaining({
        command: "sidebar.toggle",
        key: "mod+b",
        when: "!terminalFocus",
        defaultKey: "mod+b",
        defaultWhen: "",
        source: "Custom",
      }),
    ]);
  });

  it("captures platform-specific mod shortcuts", () => {
    expect(
      keybindingFromKeyboardEvent(
        { key: "K", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true },
        "MacIntel",
      ),
    ).toBe("mod+shift+k");
    expect(
      keybindingFromKeyboardEvent(
        { key: "K", metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
        "Win32",
      ),
    ).toBe("mod+shift+k");
  });

  it("serializes shortcuts and when expressions for upserts", () => {
    expect(
      shortcutToKeybindingInput({
        key: " ",
        modKey: true,
        metaKey: false,
        ctrlKey: false,
        altKey: true,
        shiftKey: false,
      }),
    ).toBe("mod+alt+space");

    expect(
      whenAstToExpression({
        type: "and",
        left: { type: "identifier", name: "editorFocus" },
        right: {
          type: "not",
          node: { type: "identifier", name: "terminalFocus" },
        },
      }),
    ).toBe("editorFocus && !terminalFocus");

    expect(parseWhenExpressionDraft("editorFocus && (!terminalFocus || modelPickerOpen)")).toEqual({
      ok: true,
      value: {
        type: "and",
        left: { type: "identifier", name: "editorFocus" },
        right: {
          type: "or",
          left: {
            type: "not",
            node: { type: "identifier", name: "terminalFocus" },
          },
          right: { type: "identifier", name: "modelPickerOpen" },
        },
      },
    });
    expect(parseWhenExpressionDraft("editorFocus &&")).toEqual({
      ok: false,
      message: "Use variables with !, &&, ||, and parentheses.",
    });

    expect(parseWhenExpressionDraft("!(terminalFocus || modelPickerOpen)")).toEqual({
      ok: true,
      value: {
        type: "not",
        node: {
          type: "or",
          left: { type: "identifier", name: "terminalFocus" },
          right: { type: "identifier", name: "modelPickerOpen" },
        },
      },
    });
  });

  it("formats commands as plain-language actions", () => {
    expect(commandLabel("commandPalette.toggle")).toBe("Open command palette");
    expect(commandLabel("themeEditor.toggle")).toBe("Toggle theme editor");
    expect(commandLabel("thread.jump.3")).toBe("Jump to chat 3");
    expect(commandLabel("modelPicker.jump.2")).toBe("Pick model 2");
  });

  it("gives every default command a purpose group and a written title", () => {
    for (const binding of DEFAULT_RESOLVED_KEYBINDINGS) {
      expect(commandLabel(binding.command)).not.toContain(":");
    }
    expect(keybindingGroupForCommand("commandPalette.toggle")).toBe("general");
    expect(keybindingGroupForCommand("thread.jump.1")).toBe("chats");
    expect(keybindingGroupForCommand("modelPicker.jump.1")).toBe("composer");
    expect(keybindingGroupForCommand("sidebar.toggle")).toBe("layout");
  });

  it("groups default bindings by purpose and collapses numbered series", () => {
    const groups = buildKeybindingGroups(buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS, ""));

    expect(groups.map((group) => group.id)).toEqual(["general", "chats", "composer", "layout"]);
    const chats = groups.find((group) => group.id === "chats");
    expect(chats?.rowCount).toBe(9);
    expect(chats?.items).toEqual([
      expect.objectContaining({
        type: "series",
        series: expect.objectContaining({
          id: "thread.jump",
          title: "Jump to chat 1–9",
          rangeKey: "mod+1–9",
          when: "",
        }),
      }),
    ]);
    const composer = groups.find((group) => group.id === "composer");
    expect(composer?.items.map((item) => item.type)).toEqual(["row", "series"]);
    expect(composer?.items[1]).toEqual(
      expect.objectContaining({
        series: expect.objectContaining({ title: "Pick model 1–9", when: "modelPickerOpen" }),
      }),
    );
    const general = groups.find((group) => group.id === "general");
    expect(
      general?.items.map((item) => (item.type === "row" ? commandLabel(item.row.command) : "")),
    ).toEqual(["Open command palette", "Toggle theme editor"]);
    // No default depends on the removed terminal or browser preview.
    expect(
      groups.flatMap((group) =>
        group.items.flatMap((item) => (item.type === "row" ? [item.row.when] : [])),
      ),
    ).toEqual(["", "", "", "", ""]);
  });

  it("drops the range shortcut when a series step was customized", () => {
    const rows = buildKeybindingRows(
      [
        { command: "thread.jump.1", shortcut: shortcut("1") },
        { command: "thread.jump.2", shortcut: shortcut("2", { alt: true }) },
      ] satisfies ResolvedKeybindingsConfig,
      "",
    );
    const [chats] = buildKeybindingGroups(rows);

    expect(chats?.items).toEqual([
      expect.objectContaining({
        series: expect.objectContaining({ title: "Jump to chat 1–2", rangeKey: null }),
      }),
    ]);
  });

  it("shows a lone matching series step as a plain row", () => {
    const rows = buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS, "jump to chat 4");
    const groups = buildKeybindingGroups(rows);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.items).toEqual([
      expect.objectContaining({
        type: "row",
        row: expect.objectContaining({ command: "thread.jump.4" }),
      }),
    ]);
  });

  it("filters to customized and conflicting bindings and summarizes both", () => {
    const rows = buildKeybindingRows(
      [
        { command: "sidebar.toggle", shortcut: shortcut("b") },
        { command: "commandPalette.toggle", shortcut: shortcut("p") },
        { command: "rightPanel.toggle", shortcut: shortcut("p") },
      ] satisfies ResolvedKeybindingsConfig,
      "",
    );

    expect(summarizeKeybindings(rows)).toEqual({ total: 3, customized: 2, conflicts: 2 });
    expect(
      buildKeybindingGroups(rows, "customized").flatMap((group) =>
        group.items.map((item) => (item.type === "row" ? item.row.command : item.series.id)),
      ),
    ).toEqual(["commandPalette.toggle", "rightPanel.toggle"]);
    expect(buildKeybindingGroups(rows, "conflicts").map((group) => group.id)).toEqual([
      "general",
      "layout",
    ]);
  });

  it("describes when clauses in plain language", () => {
    expect(describeWhenExpression(undefined)).toBeNull();
    expect(describeWhenExpression({ type: "identifier", name: "previewFocus" })).toBe(
      "When the preview is focused",
    );
    expect(
      describeWhenExpression({
        type: "not",
        node: { type: "identifier", name: "modelPickerOpen" },
      }),
    ).toBe("Unless the model picker is open");
    expect(
      describeWhenExpression({
        type: "and",
        left: { type: "identifier", name: "modelPickerOpen" },
        right: { type: "identifier", name: "previewFocus" },
      }),
    ).toBe("modelPickerOpen && previewFocus");
  });

  it("splits shortcuts into key caps in platform modifier order", () => {
    expect(keybindingDisplayParts("mod+shift+k", "MacIntel")).toEqual(["⇧", "⌘", "K"]);
    expect(keybindingDisplayParts("mod+shift+k", "Win32")).toEqual(["Ctrl", "Shift", "K"]);
    expect(keybindingDisplayParts("mod++", "MacIntel")).toEqual(["⌘", "+"]);
    expect(keybindingDisplayParts("mod+alt+arrowup", "Linux x86_64")).toEqual(["Ctrl", "Alt", "↑"]);
    expect(keybindingDisplayParts("mod+1–9", "MacIntel")).toEqual(["⌘", "1–9"]);
    expect(keybindingDisplayParts("", "MacIntel")).toEqual([]);
  });

  it("treats later scoped bindings as overrides rather than conflicts", () => {
    const defaults = buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS, "");
    expect(summarizeKeybindings(defaults).conflicts).toBe(0);

    // An unscoped binding added after a scoped one shadows it completely.
    const shadowed = buildKeybindingRows(
      [
        {
          command: "rightPanel.toggle",
          shortcut: shortcut("r"),
          whenAst: { type: "identifier", name: "previewFocus" },
        },
        { command: "sidebar.toggle", shortcut: shortcut("r") },
      ] satisfies ResolvedKeybindingsConfig,
      "",
    );
    expect(shadowed.map((row) => row.conflicts)).toEqual([
      ["Toggle sidebar"],
      ["Toggle right panel"],
    ]);

    // Drafts are appended on save, so a new scoped binding only overrides.
    expect(
      keybindingConflictLabels(defaults, {
        rowId: "new",
        key: "mod+1",
        when: "previewFocus",
      }),
    ).toEqual([]);
    expect(keybindingConflictLabels(defaults, { rowId: "new", key: "mod+k", when: "" })).toEqual([
      "Open command palette",
    ]);
  });

  it("searches by the written command title", () => {
    const rows = buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS, "command palette");
    expect(rows.map((row) => row.command)).toEqual(["commandPalette.toggle"]);
  });

  it("builds known when variable options from defaults without frontend labels", () => {
    const options = buildWhenVariableOptions();

    expect(options).toEqual(expect.arrayContaining(["modelPickerOpen", "true", "false"]));
    expect(options).not.toContain("customModeActive");
    // The terminal and browser preview were removed, so their conditions are not offered.
    expect(options).not.toContain("terminalFocus");
    expect(options).not.toContain("previewFocus");
  });

  it("builds command options from default commands without retired bindings", () => {
    const options = buildKeybindingCommandOptions([
      {
        command: "script.setup-db.run",
        shortcut: {
          key: "r",
          modKey: true,
          metaKey: false,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
        },
      },
    ] satisfies ResolvedKeybindingsConfig);

    expect(options).toEqual(expect.arrayContaining(["sidebar.toggle", "rightPanel.toggle"]));
    expect(options).not.toContain("script.setup-db.run");
    expect(options).not.toContain("terminal.toggle");
  });

  it("reports unknown when variables without rejecting parseable expressions", () => {
    const parsed = parseWhenExpressionDraft("!modelPickerOpen && modelPickerOpn");

    expect(parsed.ok).toBe(true);
    expect(unknownWhenVariables(parsed.ok ? parsed.value : undefined)).toEqual(["modelPickerOpn"]);
  });

  it("hides bindings for retired commands", () => {
    const rows = buildKeybindingRows(
      [
        {
          command: "preview.zoomIn",
          shortcut: {
            key: "=",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
          },
          whenAst: { type: "identifier", name: "previewFocus" },
        },
        {
          command: "preview.zoomIn",
          shortcut: {
            key: "+",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
          },
          whenAst: { type: "identifier", name: "previewFocus" },
        },
      ] satisfies ResolvedKeybindingsConfig,
      "",
    );

    expect(rows).toEqual([]);
  });

  it("reports conflicting shortcuts that share an active when context", () => {
    const rows = buildKeybindingRows(
      [
        {
          command: "chat.new",
          shortcut: {
            key: "n",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
          },
          whenAst: {
            type: "not",
            node: { type: "identifier", name: "terminalFocus" },
          },
        },
        {
          command: "chat.newLocal",
          shortcut: {
            key: "n",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
          },
          whenAst: {
            type: "not",
            node: { type: "identifier", name: "terminalFocus" },
          },
        },
      ] satisfies ResolvedKeybindingsConfig,
      "",
    );

    expect(rows[0]?.conflicts).toEqual(["New local chat"]);
    expect(
      keybindingConflictLabels(rows, {
        rowId: rows[0]?.id ?? "",
        key: "mod+n",
        when: "",
      }),
    ).toEqual(["New local chat"]);
  });
});
