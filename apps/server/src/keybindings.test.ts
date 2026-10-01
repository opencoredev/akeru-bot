import * as Predicate from "effect/Predicate";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Keybindings from "./keybindings.ts";

import {
  encodeResolvedKeybindingFromConfig,
  decodeResolvedKeybindingFromConfigExit,
} from "./keybindingsTestSupport.ts";

it.layer(NodeServices.layer)("keybindings", (it) => {
  it.effect("parses shortcuts including plus key", () =>
    Effect.sync(() => {
      assert.deepEqual(Keybindings.parseKeybindingShortcut("mod+j"), {
        key: "j",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      });
      assert.deepEqual(Keybindings.parseKeybindingShortcut("mod++"), {
        key: "+",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      });
    }),
  );

  it.effect("compiles valid rule with parsed when AST", () =>
    Effect.sync(() => {
      const compiled = Keybindings.compileResolvedKeybindingRule({
        key: "mod+d",
        command: "terminal.split",
        when: "terminalOpen && !terminalFocus",
      });

      assert.deepEqual(compiled, {
        command: "terminal.split",
        shortcut: {
          key: "d",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
        whenAst: {
          type: "and",
          left: { type: "identifier", name: "terminalOpen" },
          right: {
            type: "not",
            node: { type: "identifier", name: "terminalFocus" },
          },
        },
      });
    }),
  );

  it.effect("encodes resolved plus-key shortcuts", () =>
    Effect.gen(function* () {
      const encoded = yield* encodeResolvedKeybindingFromConfig({
        command: "terminal.toggle",
        shortcut: {
          key: "+",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      });

      assert.equal(encoded.key, "mod++");
      assert.equal(encoded.command, "terminal.toggle");
    }),
  );

  it.effect("rejects invalid rules", () =>
    Effect.sync(() => {
      assert.isNull(
        Keybindings.compileResolvedKeybindingRule({
          key: "mod+shift+d+o",
          command: "terminal.new",
        }),
      );

      assert.isNull(
        Keybindings.compileResolvedKeybindingRule({
          key: "mod+d",
          command: "terminal.split",
          when: "terminalFocus && (",
        }),
      );

      assert.isNull(
        Keybindings.compileResolvedKeybindingRule({
          key: "mod+d",
          command: "terminal.split",
          when: `${"!".repeat(300)}terminalFocus`,
        }),
      );
    }),
  );

  it.effect("formats invalid resolved keybinding rules with the custom message", () =>
    Effect.sync(() => {
      const result = decodeResolvedKeybindingFromConfigExit({
        key: "mod+shift+d+o",
        command: "terminal.new",
      });

      if (!Predicate.isTagged(result, "Failure")) {
        assert.fail("Expected invalid keybinding decode to fail");
      }

      const detail = Cause.pretty(result.cause);
      assert.isTrue(detail.includes("Invalid keybinding rule"));
      assert.isFalse(detail.includes("Invalid data"));
    }),
  );

  it.effect("ships only defaults with a live handler", () =>
    Effect.sync(() => {
      const defaultsByCommand = new Map(
        Keybindings.DEFAULT_KEYBINDINGS.map((binding) => [binding.command, binding.key] as const),
      );

      assert.equal(defaultsByCommand.get("thread.jump.1"), "mod+1");
      assert.equal(defaultsByCommand.get("thread.jump.9"), "mod+9");
      assert.equal(defaultsByCommand.get("themeEditor.toggle"), "mod+alt+shift+t");
      assert.equal(defaultsByCommand.get("commandPalette.toggle"), "mod+k");
      assert.equal(defaultsByCommand.get("composer.stash"), "mod+s");
      assert.equal(defaultsByCommand.get("sidebar.toggle"), "mod+b");
      assert.equal(defaultsByCommand.get("rightPanel.toggle"), "mod+alt+b");
      assert.isFalse(defaultsByCommand.has("rightPanel.toggleMaximized"));
      assert.equal(defaultsByCommand.get("modelPicker.jump.1"), "mod+1");
      assert.equal(defaultsByCommand.get("modelPicker.jump.9"), "mod+9");

      for (const retiredCommand of [
        "terminal.toggle",
        "terminal.split",
        "terminal.splitVertical",
        "terminal.new",
        "terminal.close",
        "diff.toggle",
        "filePicker.toggle",
        "projectSearch.toggle",
        "chat.new",
        "chat.newLocal",
        "modelPicker.toggle",
        "editor.openFavorite",
        "thread.previous",
        "thread.next",
        "thread.settle",
        "preview.toggle",
        "preview.refresh",
        "preview.focusUrl",
        "preview.zoomIn",
        "preview.zoomOut",
        "preview.resetZoom",
      ] as const) {
        assert.isFalse(defaultsByCommand.has(retiredCommand), `unexpected ${retiredCommand}`);
      }

      // The terminal is gone, so no default may depend on its focus state.
      for (const binding of Keybindings.DEFAULT_KEYBINDINGS) {
        assert.isFalse(
          binding.when?.includes("terminal") ?? false,
          `${binding.command} still depends on the terminal`,
        );
      }
    }),
  );
});
