import { type RefObject, useEffect, useRef } from "react";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { resolveShortcutCommand } from "../../keybindings";
import type { ResolvedKeybindingsConfig } from "@akeru/contracts";
import { shouldFocusBotPromptForKey } from "./botPromptComposer.logic";

/**
 * Window-level keys for an editable bot composer: the stash shortcut stashes the draft, and
 * a printable key typed outside any text field lands in the prompt and focuses it.
 */
export function useBotComposerKeyboard(input: {
  readonly readOnly: boolean;
  readonly typeToFocus: boolean;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly promptInputRef: RefObject<HTMLTextAreaElement | null>;
  readonly persistDraft: (next: string) => void;
  readonly stashCurrentPrompt: () => Promise<void>;
}) {
  const { keybindings, promptInputRef, readOnly, stashCurrentPrompt, typeToFocus } = input;
  const persistDraftRef = useRef(input.persistDraft);
  persistDraftRef.current = input.persistDraft;

  useEffect(() => {
    if (readOnly) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const shortcutCommand = resolveShortcutCommand(event, keybindings, {
        context: {
          modelPickerOpen: false,
        },
      });

      if (shortcutCommand === "composer.stash") {
        event.preventDefault();
        event.stopPropagation();

        if (!event.repeat && !isCommandPaletteOpen()) void stashCurrentPrompt();

        return;
      }

      const target = event.target;

      const editableTarget =
        target instanceof Element &&
        target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]',
        ) !== null;

      if (
        !typeToFocus ||
        !shouldFocusBotPromptForKey({
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          defaultPrevented: event.defaultPrevented,
          editableTarget,
          isComposing: event.isComposing,
          key: event.key,
          metaKey: event.metaKey,
        })
      ) {
        return;
      }

      event.preventDefault();
      persistDraftRef.current(`${promptInputRef.current?.value ?? ""}${event.key}`);
      promptInputRef.current?.focus();
    };

    window.addEventListener("keydown", onKeyDown, true);

    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [keybindings, promptInputRef, readOnly, stashCurrentPrompt, typeToFocus]);
}
