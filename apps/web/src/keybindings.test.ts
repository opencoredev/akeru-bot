import { assert, describe, it } from "vite-plus/test";
import {
  modelPickerJumpCommandForIndex,
  modelPickerJumpIndexFromCommand,
  resolveShortcutCommand,
  shouldShowModelPickerJumpHints,
  shouldShowThreadJumpHints,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
} from "./keybindings";
import { event, DEFAULT_BINDINGS, isOpenFavoriteEditorShortcut } from "./keybindings.test-support";

describe("thread navigation helpers", () => {
  it("maps jump commands to visible thread indices", () => {
    assert.strictEqual(threadJumpCommandForIndex(0), "thread.jump.1");
    assert.strictEqual(threadJumpCommandForIndex(2), "thread.jump.3");
    assert.isNull(threadJumpCommandForIndex(9));
    assert.strictEqual(threadJumpIndexFromCommand("thread.jump.1"), 0);
    assert.strictEqual(threadJumpIndexFromCommand("thread.jump.3"), 2);
    assert.isNull(threadJumpIndexFromCommand("thread.next"));
  });

  it("shows jump hints only when configured modifiers match", () => {
    assert.isTrue(
      shouldShowThreadJumpHints(event({ metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
    );
    assert.isFalse(
      shouldShowThreadJumpHints(event({ metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
    );
    assert.isTrue(
      shouldShowThreadJumpHints(event({ ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
      }),
    );
  });
});

describe("model picker navigation helpers", () => {
  it("maps jump commands to visible model indices", () => {
    assert.strictEqual(modelPickerJumpCommandForIndex(0), "modelPicker.jump.1");
    assert.strictEqual(modelPickerJumpCommandForIndex(2), "modelPicker.jump.3");
    assert.isNull(modelPickerJumpCommandForIndex(9));
    assert.strictEqual(modelPickerJumpIndexFromCommand("modelPicker.jump.1"), 0);
    assert.strictEqual(modelPickerJumpIndexFromCommand("modelPicker.jump.3"), 2);
    assert.isNull(modelPickerJumpIndexFromCommand("thread.jump.1"));
  });

  it("shows jump hints only while the model picker context is active", () => {
    assert.isFalse(
      shouldShowModelPickerJumpHints(event({ metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { modelPickerOpen: false },
      }),
    );
    assert.isTrue(
      shouldShowModelPickerJumpHints(event({ metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { modelPickerOpen: true },
      }),
    );
  });
});

describe("chat/editor shortcuts", () => {
  it("matches editor.openFavorite shortcut", () => {
    assert.isTrue(
      isOpenFavoriteEditorShortcut(event({ key: "o", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
      }),
    );
    assert.isTrue(
      isOpenFavoriteEditorShortcut(event({ key: "o", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
      }),
    );
  });

  it("matches commandPalette.toggle shortcut outside terminal focus", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "k", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "commandPalette.toggle",
    );
    assert.notStrictEqual(
      resolveShortcutCommand(event({ key: "k", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
      "commandPalette.toggle",
    );
  });

  it("matches filePicker.toggle shortcut outside terminal focus", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "p", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "filePicker.toggle",
    );
    assert.notStrictEqual(
      resolveShortcutCommand(event({ key: "p", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
      "filePicker.toggle",
    );
  });

  it("matches projectSearch.toggle shortcut outside terminal focus", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "f", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "projectSearch.toggle",
    );
    assert.notStrictEqual(
      resolveShortcutCommand(event({ key: "f", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
      "projectSearch.toggle",
    );
  });

  it("matches themeEditor.toggle on macOS and Windows", () => {
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "t", metaKey: true, altKey: true, shiftKey: true }),
        DEFAULT_BINDINGS,
        { platform: "MacIntel" },
      ),
      "themeEditor.toggle",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "t", ctrlKey: true, altKey: true, shiftKey: true }),
        DEFAULT_BINDINGS,
        { platform: "Win32" },
      ),
      "themeEditor.toggle",
    );
  });
});
