import { type ServerProviderSkill } from "@akeru/contracts";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createRangeSelectionFromDom,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  BLUR_COMMAND,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  DecoratorNode,
  FOCUS_COMMAND,
  HISTORY_MERGE_TAG,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DOWN_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_TAB_COMMAND,
} from "lexical";
import { use, useEffect, useEffectEvent, useRef } from "react";
import { selectionTouchesMentionBoundary } from "~/composer-editor-mentions";
import {
  collapseExpandedComposerCursor,
  isCollapsedCursorAdjacentToInlineToken,
} from "~/composer-logic";
import { type TerminalContextDraft } from "~/lib/terminalContext";
import { isMacPlatform } from "~/lib/utils";
import { registerComposerInlineTokenPaste } from "../composerInlineTokenPaste";
import { skillMetadataByName } from "../composerSkillNode";
import {
  $createComposerMentionNode,
  ComposerTerminalContextActionsContext,
  ComposerTerminalContextNode,
  isComposerInlineTokenNode,
} from "./ComposerInlineTokenNodes";
import {
  $getComposerRootLength,
  $readSelectionOffsetFromEditorState,
  $selectionTouchesInlineToken,
  $setComposerEditorPrompt,
  $setSelectionAtComposerOffset,
  $setSelectionRangeAtComposerOffsets,
  getAbsoluteOffsetForPoint,
  getExpandedAbsoluteOffsetForPoint,
  getSelectionRangeForExpandedComposerOffsets,
} from "./composerSelection";

const SURROUND_SYMBOLS: [string, string][] = [
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
  ["'", "'"],
  ['"', '"'],
  ["“", "”"],
  ["`", "`"],
  ["<", ">"],
  ["«", "»"],
  ["*", "*"],
  ["_", "_"],
];

const SURROUND_SYMBOLS_MAP = new Map<string, string>(SURROUND_SYMBOLS);

const BACKTICK_SURROUND_CLOSE_SYMBOL = SURROUND_SYMBOLS_MAP.get("`") ?? null;

export function ComposerCommandKeyPlugin(props: {
  onCommandKeyDown?: (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab",
    event: KeyboardEvent,
  ) => boolean;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const handleCommand = (
      key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab",
      event: KeyboardEvent | null,
    ): boolean => {
      if (!props.onCommandKeyDown || !event) {
        return false;
      }

      if (key === "Enter" && (event.isComposing || event.keyCode === 229)) {
        event.stopPropagation();
        return true;
      }

      const handled = props.onCommandKeyDown(key, event);
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
      return handled;
    };

    const unregisterArrowDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => handleCommand("ArrowDown", event),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterArrowUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => handleCommand("ArrowUp", event),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => handleCommand("Enter", event),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterTab = editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => handleCommand("Tab", event),
      COMMAND_PRIORITY_HIGH,
    );

    return () => {
      unregisterArrowDown();
      unregisterArrowUp();
      unregisterEnter();
      unregisterTab();
    };
  }, [editor, props]);

  return null;
}

export function ComposerInlineTokenArrowPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const unregisterLeft = editor.registerCommand(
      KEY_ARROW_LEFT_COMMAND,
      (event) => {
        let nextOffset: number | null = null;
        editor.getEditorState().read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
          const currentOffset = $readSelectionOffsetFromEditorState(0);
          if (currentOffset <= 0) return;
          const promptValue = $getRoot().getTextContent();
          if (!isCollapsedCursorAdjacentToInlineToken(promptValue, currentOffset, "left")) {
            return;
          }
          nextOffset = currentOffset - 1;
        });
        if (nextOffset === null) return false;
        const selectionOffset = nextOffset;
        event?.preventDefault();
        event?.stopPropagation();
        editor.update(() => {
          $setSelectionAtComposerOffset(selectionOffset);
        });
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterRight = editor.registerCommand(
      KEY_ARROW_RIGHT_COMMAND,
      (event) => {
        let nextOffset: number | null = null;
        editor.getEditorState().read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
          const currentOffset = $readSelectionOffsetFromEditorState(0);
          const composerLength = $getComposerRootLength();
          if (currentOffset >= composerLength) return;
          const promptValue = $getRoot().getTextContent();
          if (!isCollapsedCursorAdjacentToInlineToken(promptValue, currentOffset, "right")) {
            return;
          }
          nextOffset = currentOffset + 1;
        });
        if (nextOffset === null) return false;
        const selectionOffset = nextOffset;
        event?.preventDefault();
        event?.stopPropagation();
        editor.update(() => {
          $setSelectionAtComposerOffset(selectionOffset);
        });
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
    return () => {
      unregisterLeft();
      unregisterRight();
    };
  }, [editor]);

  return null;
}

export function ComposerHomeEndKeyPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event) => {
        if (!isMacPlatform(navigator.platform)) {
          return false;
        }
        if (event.key !== "Home" && event.key !== "End") {
          return false;
        }
        if (event.altKey || event.metaKey || event.ctrlKey || event.isComposing) {
          return false;
        }

        const rootElement = editor.getRootElement();
        const selection = window.getSelection();
        const anchorNode = selection?.anchorNode;
        if (!rootElement || !selection || !anchorNode || !rootElement.contains(anchorNode)) {
          return false;
        }
        if (selection.rangeCount === 0 || typeof selection.modify !== "function") {
          return false;
        }

        event.preventDefault();
        event.stopPropagation();

        selection.modify(
          event.shiftKey ? "extend" : "move",
          event.key === "Home" ? "backward" : "forward",
          "lineboundary",
        );
        editor.update(() => {
          $setSelection($createRangeSelectionFromDom(selection, editor));
        });
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor]);

  return null;
}

export function ComposerInlineTokenSelectionNormalizePlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      let afterOffset: number | null = null;
      editorState.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
        const anchorNode = selection.anchor.getNode();
        if (!isComposerInlineTokenNode(anchorNode)) return;
        if (selection.anchor.offset === 0) return;
        const beforeOffset = getAbsoluteOffsetForPoint(anchorNode, 0);
        afterOffset = beforeOffset + 1;
      });
      if (afterOffset !== null) {
        queueMicrotask(() => {
          editor.update(() => {
            $setSelectionAtComposerOffset(afterOffset!);
          });
        });
      }
    });
  }, [editor]);

  return null;
}

export function ComposerInlineTokenBackspacePlugin() {
  const [editor] = useLexicalComposerContext();
  const { onRemoveTerminalContext } = use(ComposerTerminalContextActionsContext);

  useEffect(() => {
    return editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      (event) => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          return false;
        }

        const anchorNode = selection.anchor.getNode();
        const selectionOffset = $readSelectionOffsetFromEditorState(0);
        const removeInlineTokenNode = (candidate: unknown): boolean => {
          if (!isComposerInlineTokenNode(candidate)) {
            return false;
          }
          const tokenStart = getAbsoluteOffsetForPoint(candidate, 0);
          candidate.remove();
          if (candidate instanceof ComposerTerminalContextNode) {
            onRemoveTerminalContext(candidate.__context.id);
            $setSelectionAtComposerOffset(selectionOffset);
          } else {
            $setSelectionAtComposerOffset(tokenStart);
          }
          event?.preventDefault();
          return true;
        };
        if (removeInlineTokenNode(anchorNode)) {
          return true;
        }

        if ($isTextNode(anchorNode)) {
          if (selection.anchor.offset > 0) {
            return false;
          }
          if (removeInlineTokenNode(anchorNode.getPreviousSibling())) {
            return true;
          }
          const parent = anchorNode.getParent();
          if ($isElementNode(parent)) {
            const index = anchorNode.getIndexWithinParent();
            if (index > 0 && removeInlineTokenNode(parent.getChildAtIndex(index - 1))) {
              return true;
            }
          }
          return false;
        }

        if ($isElementNode(anchorNode)) {
          const childIndex = selection.anchor.offset - 1;
          if (childIndex >= 0 && removeInlineTokenNode(anchorNode.getChildAtIndex(childIndex))) {
            return true;
          }
        }

        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onRemoveTerminalContext]);

  return null;
}

/**
 * Chips render as non-editable decorators, so the browser never paints the
 * native text selection over them; without help, a selection spanning chips
 * is only visible in the slivers between them. Mirror the selection onto the
 * chips with a data attribute the stylesheet turns into a highlight overlay.
 */
export function ComposerChipSelectionPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    let selectedKeys = new Set<string>();
    // Lexical keeps the range selection on blur without emitting an update,
    // so focus is tracked separately; while blurred the native highlight is
    // gone and the mirrored one has to go with it.
    let hasFocus = editor.getRootElement() === document.activeElement;

    const applyKeys = (nextKeys: Set<string>) => {
      for (const key of selectedKeys) {
        if (!nextKeys.has(key)) {
          editor.getElementByKey(key)?.removeAttribute("data-composer-chip-selected");
        }
      }
      for (const key of nextKeys) {
        editor.getElementByKey(key)?.setAttribute("data-composer-chip-selected", "true");
      }
      selectedKeys = nextKeys;
    };

    const readSelectedKeys = () => {
      const nextKeys = new Set<string>();
      editor.getEditorState().read(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection) && !selection.isCollapsed()) {
          for (const node of selection.getNodes()) {
            if (node instanceof DecoratorNode) {
              nextKeys.add(node.getKey());
            }
          }
        }
      });
      return nextKeys;
    };

    const unregisterUpdate = editor.registerUpdateListener(() => {
      applyKeys(hasFocus ? readSelectedKeys() : new Set());
    });
    const unregisterFocus = editor.registerCommand(
      FOCUS_COMMAND,
      () => {
        hasFocus = true;
        applyKeys(readSelectedKeys());
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
    const unregisterBlur = editor.registerCommand(
      BLUR_COMMAND,
      () => {
        hasFocus = false;
        applyKeys(new Set());
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
    return () => {
      unregisterUpdate();
      unregisterFocus();
      unregisterBlur();
    };
  }, [editor]);

  return null;
}

export function ComposerInlineTokenPastePlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(
    () =>
      registerComposerInlineTokenPaste(editor, {
        createMentionNode: $createComposerMentionNode,
        getExpandedAbsoluteOffsetForPoint,
      }),
    [editor],
  );

  return null;
}

export function ComposerSurroundSelectionPlugin(props: {
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  skills: ReadonlyArray<ServerProviderSkill>;
}) {
  const [editor] = useLexicalComposerContext();
  const terminalContextsRef = useRef(props.terminalContexts);
  const skillMetadataRef = useRef(skillMetadataByName(props.skills));
  const pendingSurroundSelectionRef = useRef<{
    value: string;
    expandedStart: number;
    expandedEnd: number;
  } | null>(null);
  const pendingDeadKeySelectionRef = useRef<{
    value: string;
    expandedStart: number;
    expandedEnd: number;
  } | null>(null);

  useEffect(() => {
    terminalContextsRef.current = props.terminalContexts;
  }, [props.terminalContexts]);

  useEffect(() => {
    skillMetadataRef.current = skillMetadataByName(props.skills);
  }, [props.skills]);

  const applySurroundInsertion = useEffectEvent((inputData: string): boolean => {
    const surroundCloseSymbol = SURROUND_SYMBOLS_MAP.get(inputData);
    const pendingSurroundSelection = pendingSurroundSelectionRef.current;
    if (!surroundCloseSymbol) {
      pendingSurroundSelectionRef.current = null;
      return false;
    }

    let handled = false;
    editor.update(() => {
      const selectionSnapshot =
        pendingSurroundSelection ??
        (() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || selection.isCollapsed()) {
            return null;
          }
          if ($selectionTouchesInlineToken(selection)) {
            return null;
          }
          const range = getSelectionRangeForExpandedComposerOffsets(selection);
          if (!range || range.start === range.end) {
            return null;
          }
          const value = $getRoot().getTextContent();
          if (selectionTouchesMentionBoundary(value, range.start, range.end)) {
            return null;
          }
          return {
            value,
            expandedStart: range.start,
            expandedEnd: range.end,
          };
        })();

      if (!selectionSnapshot || !surroundCloseSymbol) {
        return;
      }

      const selectedText = selectionSnapshot.value.slice(
        selectionSnapshot.expandedStart,
        selectionSnapshot.expandedEnd,
      );
      const nextValue = `${selectionSnapshot.value.slice(0, selectionSnapshot.expandedStart)}${inputData}${selectedText}${surroundCloseSymbol}${selectionSnapshot.value.slice(selectionSnapshot.expandedEnd)}`;
      $setComposerEditorPrompt(nextValue, terminalContextsRef.current, skillMetadataRef.current);
      const selectionStart = collapseExpandedComposerCursor(
        nextValue,
        selectionSnapshot.expandedStart,
      );
      $setSelectionRangeAtComposerOffsets(
        selectionStart + inputData.length,
        selectionStart + inputData.length + selectedText.length,
      );
      handled = true;
      pendingSurroundSelectionRef.current = null;
    });

    return handled;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (pendingDeadKeySelectionRef.current) {
        if (event.key === "Dead" || event.key === " " || event.code === "Space") {
          return;
        }
        pendingDeadKeySelectionRef.current = null;
      }

      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey) {
        pendingSurroundSelectionRef.current = null;
        pendingDeadKeySelectionRef.current = null;
        return;
      }

      editor.getEditorState().read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || selection.isCollapsed()) {
          pendingSurroundSelectionRef.current = null;
          pendingDeadKeySelectionRef.current = null;
          return;
        }
        if ($selectionTouchesInlineToken(selection)) {
          pendingSurroundSelectionRef.current = null;
          pendingDeadKeySelectionRef.current = null;
          return;
        }
        const range = getSelectionRangeForExpandedComposerOffsets(selection);
        if (!range || range.start === range.end) {
          pendingSurroundSelectionRef.current = null;
          pendingDeadKeySelectionRef.current = null;
          return;
        }
        const value = $getRoot().getTextContent();
        if (selectionTouchesMentionBoundary(value, range.start, range.end)) {
          pendingSurroundSelectionRef.current = null;
          pendingDeadKeySelectionRef.current = null;
          return;
        }
        const snapshot = {
          value,
          expandedStart: range.start,
          expandedEnd: range.end,
        };
        pendingSurroundSelectionRef.current = snapshot;
        pendingDeadKeySelectionRef.current = null;
      });
    };

    const onBeforeInput = (event: InputEvent) => {
      if (
        event.inputType === "insertCompositionText" &&
        event.data === "`" &&
        BACKTICK_SURROUND_CLOSE_SYMBOL !== null &&
        pendingSurroundSelectionRef.current
      ) {
        pendingDeadKeySelectionRef.current = pendingSurroundSelectionRef.current;
        return;
      }

      if (pendingDeadKeySelectionRef.current) {
        return;
      }

      if (event.inputType === "insertCompositionText") {
        return;
      }

      if (typeof event.data !== "string") {
        pendingSurroundSelectionRef.current = null;
        return;
      }
      const inputData = event.inputType === "insertText" ? event.data : null;
      if (!inputData || inputData.length !== 1) {
        pendingSurroundSelectionRef.current = null;
        return;
      }
      if (!applySurroundInsertion(inputData)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    const tryApplyDeadKeyBacktickSurround = (options?: { finalAttempt?: boolean }) => {
      queueMicrotask(() => {
        editor.update(
          () => {
            const pendingDeadKeySelection = pendingDeadKeySelectionRef.current;
            if (!pendingDeadKeySelection) {
              return;
            }

            const currentValue = $getRoot().getTextContent();
            const backtickCloseSymbol = BACKTICK_SURROUND_CLOSE_SYMBOL;
            if (backtickCloseSymbol === null) {
              pendingDeadKeySelectionRef.current = null;
              return;
            }

            const expectedResolvedValue = `${pendingDeadKeySelection.value.slice(0, pendingDeadKeySelection.expandedStart)}\`${pendingDeadKeySelection.value.slice(pendingDeadKeySelection.expandedEnd)}`;
            if (currentValue !== expectedResolvedValue) {
              if (options?.finalAttempt) {
                pendingSurroundSelectionRef.current = null;
                pendingDeadKeySelectionRef.current = null;
              }
              return;
            }

            const selectedText = pendingDeadKeySelection.value.slice(
              pendingDeadKeySelection.expandedStart,
              pendingDeadKeySelection.expandedEnd,
            );
            const replacementStart = collapseExpandedComposerCursor(
              currentValue,
              pendingDeadKeySelection.expandedStart,
            );
            $setSelectionRangeAtComposerOffsets(replacementStart, replacementStart + 1);
            const replacementSelection = $getSelection();
            if (!$isRangeSelection(replacementSelection)) {
              pendingSurroundSelectionRef.current = null;
              pendingDeadKeySelectionRef.current = null;
              return;
            }
            replacementSelection.insertText(`\`${selectedText}${backtickCloseSymbol}`);
            $setSelectionRangeAtComposerOffsets(
              replacementStart + 1,
              replacementStart + 1 + selectedText.length,
            );
            pendingSurroundSelectionRef.current = null;
            pendingDeadKeySelectionRef.current = null;
          },
          { tag: HISTORY_MERGE_TAG },
        );
      });
    };

    const onInput = (event: Event) => {
      const inputEvent = event as InputEvent;
      if (
        inputEvent.inputType === "insertText" ||
        inputEvent.inputType === "insertCompositionText"
      ) {
        tryApplyDeadKeyBacktickSurround();
      }
    };

    const onCompositionEnd = () => {
      tryApplyDeadKeyBacktickSurround({ finalAttempt: true });
    };

    let activeRootElement: HTMLElement | null = null;
    const unregisterRootListener = editor.registerRootListener((rootElement, prevRootElement) => {
      prevRootElement?.removeEventListener("keydown", onKeyDown);
      prevRootElement?.removeEventListener("beforeinput", onBeforeInput, true);
      prevRootElement?.removeEventListener("input", onInput);
      prevRootElement?.removeEventListener("compositionend", onCompositionEnd);
      rootElement?.addEventListener("keydown", onKeyDown);
      rootElement?.addEventListener("beforeinput", onBeforeInput, true);
      rootElement?.addEventListener("input", onInput);
      rootElement?.addEventListener("compositionend", onCompositionEnd);
      activeRootElement = rootElement;
    });

    return () => {
      if (activeRootElement) {
        activeRootElement.removeEventListener("keydown", onKeyDown);
        activeRootElement.removeEventListener("beforeinput", onBeforeInput, true);
        activeRootElement.removeEventListener("input", onInput);
        activeRootElement.removeEventListener("compositionend", onCompositionEnd);
      }
      unregisterRootListener();
    };
  }, [editor]);

  return null;
}
