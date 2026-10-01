import {
  type KeybindingCommand,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ResolvedKeybindingsConfig,
} from "@akeru/contracts";
import { resolveShortcutCommand, type ShortcutEventLike } from "./keybindings";

// The matcher is command-agnostic; these fixtures exercise it through a few
// contract commands that still decode from older keybindings files.
const matchesCommand =
  (command: KeybindingCommand) =>
  (
    shortcutEvent: ShortcutEventLike,
    keybindings: ResolvedKeybindingsConfig,
    options?: Parameters<typeof resolveShortcutCommand>[2],
  ) =>
    resolveShortcutCommand(shortcutEvent, keybindings, options) === command;

export const isTerminalToggleShortcut = matchesCommand("terminal.toggle");

export const isTerminalSplitShortcut = matchesCommand("terminal.split");

export const isTerminalSplitVerticalShortcut = matchesCommand("terminal.splitVertical");

export const isTerminalNewShortcut = matchesCommand("terminal.new");

export const isTerminalCloseShortcut = matchesCommand("terminal.close");

export const isOpenFavoriteEditorShortcut = matchesCommand("editor.openFavorite");

export function event(overrides: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return {
    key: "j",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

export function modShortcut(
  key: string,
  overrides: Partial<Omit<KeybindingShortcut, "key">> = {},
): KeybindingShortcut {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    modKey: true,
    ...overrides,
  };
}

export function whenIdentifier(name: string): KeybindingWhenNode {
  return { type: "identifier", name };
}

export function whenNot(node: KeybindingWhenNode): KeybindingWhenNode {
  return { type: "not", node };
}

export function whenAnd(left: KeybindingWhenNode, right: KeybindingWhenNode): KeybindingWhenNode {
  return { type: "and", left, right };
}

interface TestBinding {
  shortcut: KeybindingShortcut;
  command: KeybindingCommand;
  whenAst?: KeybindingWhenNode;
}

export function compile(bindings: TestBinding[]): ResolvedKeybindingsConfig {
  return bindings.map((binding) => ({
    command: binding.command,
    shortcut: binding.shortcut,
    ...(binding.whenAst ? { whenAst: binding.whenAst } : {}),
  }));
}

export const DEFAULT_BINDINGS = compile([
  { shortcut: modShortcut("b"), command: "sidebar.toggle" },
  { shortcut: modShortcut("j"), command: "terminal.toggle" },
  { shortcut: modShortcut("b", { altKey: true }), command: "rightPanel.toggle" },
  {
    shortcut: modShortcut("d"),
    command: "terminal.split",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("d", { shiftKey: true }),
    command: "terminal.splitVertical",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("n"),
    command: "terminal.new",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("w"),
    command: "terminal.close",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("d"),
    command: "diff.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("k"),
    command: "commandPalette.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("p"),
    command: "filePicker.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("f", { shiftKey: true }),
    command: "projectSearch.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("t", { altKey: true, shiftKey: true }),
    command: "themeEditor.toggle",
  },
  {
    shortcut: modShortcut("m", { shiftKey: true }),
    command: "modelPicker.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  { shortcut: modShortcut("o", { shiftKey: true }), command: "chat.new" },
  { shortcut: modShortcut("n", { shiftKey: true }), command: "chat.newLocal" },
  { shortcut: modShortcut("o"), command: "editor.openFavorite" },
  { shortcut: modShortcut("[", { shiftKey: true }), command: "thread.previous" },
  { shortcut: modShortcut("]", { shiftKey: true }), command: "thread.next" },
  {
    shortcut: modShortcut("s", { shiftKey: true }),
    command: "thread.settle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  { shortcut: modShortcut("1"), command: "thread.jump.1" },
  { shortcut: modShortcut("2"), command: "thread.jump.2" },
  { shortcut: modShortcut("3"), command: "thread.jump.3" },
  {
    shortcut: modShortcut("1"),
    command: "modelPicker.jump.1",
    whenAst: whenIdentifier("modelPickerOpen"),
  },
  {
    shortcut: modShortcut("2"),
    command: "modelPicker.jump.2",
    whenAst: whenIdentifier("modelPickerOpen"),
  },
  {
    shortcut: modShortcut("3"),
    command: "modelPicker.jump.3",
    whenAst: whenIdentifier("modelPickerOpen"),
  },
]);
