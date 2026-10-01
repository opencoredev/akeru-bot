import type { GhosttyTerminalSurfaceOptions } from "./surfaceTypes";
import { isMacPlatform } from "../../lib/utils";
import type { GhosttyTerminalCore } from "./core";

import { type TerminalLatencyCallbacks } from "../latency";

import {
  isTerminalAltGraphText,
  isTerminalCopyShortcut,
  isTerminalPasteShortcut,
  isTerminalCompositionKey,
  primeTerminalCopyInput,
  clearPrimedTerminalCopyInput,
  applyTerminalCopyEvent,
  isTerminalCompositionCommitInput,
} from "./surfaceInput";

interface SurfaceKeyboardHost {
  readonly input: Pick<HTMLTextAreaElement, "value" | "select">;
  readonly core: Pick<GhosttyTerminalCore, "encodeKey" | "encodePaste">;
  readonly disposed: boolean;
  readonly options: Pick<GhosttyTerminalSurfaceOptions, "beforeKey" | "onData">;
  readonly latencyCallbacks: Pick<TerminalLatencyCallbacks, "onKeypress">;
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
  updateLinkModifier(event: Pick<KeyboardEvent, "ctrlKey" | "metaKey">): void;
}

export class SurfaceKeyboardController {
  constructor(private readonly host: SurfaceKeyboardHost) {}

  private compositionInputToSuppress: string | null = null;

  compositionSuppressionTimer: number | null = null;

  private composing = false;

  private readonly suppressedKeyCodes = new Set<string>();

  private pasteShortcutToken = 0;

  private copyShortcutToken = 0;

  private clearSelectionAfterCopy = false;

  private primedCopySelection = "";

  /**
   * Pastes clipboard text read by the host (context menu) with the same
   * bracketed-paste encoding as a native paste event. The read joins the same
   * race the paste shortcut uses — the token is claimed before it starts — so
   * a shortcut or native paste arriving during the read supersedes this one
   * instead of both reaching the shell.
   */
  async pasteFromClipboard(
    readText: () => Promise<string>,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    const token = ++this.pasteShortcutToken;
    const text = await readText();

    if (this.host.disposed || this.pasteShortcutToken !== token || !isCurrent()) return;
    // As in every paste path, delivering bumps the token so a clipboard read
    // still in flight cannot land after this text reaches the shell.
    this.pasteShortcutToken += 1;

    if (text.length === 0) return;
    const encoded = this.host.core.encodePaste(text);

    if (encoded.length > 0) this.host.options.onData(encoded);
  }

  readonly onKeyDown = (event: KeyboardEvent) => {
    this.host.updateLinkModifier(event);

    // Presses handled outside the terminal must also swallow their release:
    // beforeKey runs side effects (keybindings, navigation sends), so it cannot
    // be consulted again on keyup, and Kitty report-event-types sessions would
    // otherwise receive a release for a press the shell never saw.
    if (isTerminalAltGraphText(event) || !this.host.options.beforeKey(event)) {
      this.suppressedKeyCodes.add(event.code);

      return;
    }

    if (isTerminalCopyShortcut(event) && this.host.hasSelection()) {
      // A plain Ctrl+C/Cmd+C fires the browser's native copy event, caught in
      // onCopyEvent; not preventing the default keeps that path alive. WebKit
      // omits the keyboard copy event without a DOM selection, so race the
      // clipboard write against it the same way paste races its read. The
      // Shift variant has no native event (Chrome binds Ctrl+Shift+C to
      // inspect), so synthesize one with execCommand("copy").
      const selection = this.host.getSelection();
      this.primeCopy(selection);

      if (event.shiftKey) {
        event.preventDefault();
        document.execCommand("copy");
      } else {
        // A plain Ctrl+C is also SIGINT on non-mac: clear the selection once
        // it copies so the next Ctrl+C reaches the shell. The Shift chord and
        // Cmd+C are copy-only, so they keep the selection; resetting the flag
        // up front also drops any clear owed by an earlier gesture that never
        // completed.
        this.clearSelectionAfterCopy = !event.shiftKey && !isMacPlatform(navigator.platform);
        const clipboard = navigator.clipboard;

        if (typeof clipboard?.writeText === "function") {
          // Defer the write past the default action: the native copy event
          // (dispatched synchronously with the default action) claims the
          // token first when it actually writes, and the write covers browsers
          // whose shortcut produces no copy event. The primed textarea is what
          // Electron's edit-menu Copy reads if it runs after this handler.
          const token = ++this.copyShortcutToken;
          void Promise.resolve().then(() => {
            if (this.host.disposed || this.copyShortcutToken !== token) return;
            void clipboard.writeText(selection).then(
              () => {
                // The write may have been superseded while in flight; only
                // touch the selection if this gesture still owns the token.
                if (this.host.disposed || this.copyShortcutToken !== token) return;

                if (this.clearSelectionAfterCopy) {
                  this.clearSelectionAfterCopy = false;
                  this.host.clearSelection();
                }
              },
              () => {
                // The write failed and the native event has already had its
                // chance, so nothing copied and no clear is owed by this
                // gesture; a newer one may have just set the flag, so only
                // drop it if this gesture still owns the token.
                if (this.copyShortcutToken === token) {
                  this.clearSelectionAfterCopy = false;
                }
              },
            );
          });
        }
      }

      this.suppressedKeyCodes.add(event.code);

      return;
    }

    if (isTerminalPasteShortcut(event)) {
      this.suppressedKeyCodes.add(event.code);
      const clipboard = navigator.clipboard;

      if (typeof clipboard?.readText === "function") {
        // Race the async clipboard read against the browser's own paste event:
        // the native event (dispatched synchronously with the default action)
        // always claims the token first when it fires, and the read covers
        // browsers whose paste shortcut produces no paste event. Not preventing
        // the default keeps the native path alive when the read is denied.
        const token = ++this.pasteShortcutToken;
        void clipboard.readText().then(
          (text) => {
            if (this.host.disposed || this.pasteShortcutToken !== token) return;
            this.pasteShortcutToken += 1;

            if (text.length > 0) this.host.options.onData(this.host.core.encodePaste(text));
          },
          () => {
            // Clipboard read denied; the native paste event remains the path.
          },
        );
      }

      return;
    }

    // keyCode 229 is Safari's only signal that this keydown opens an IME
    // composition; encoding it would double the committed text. Do not blank
    // the textarea first: onInput leaves the in-progress candidate there.
    if (isTerminalCompositionKey(event, this.composing)) {
      return;
    }

    this.clearPrimedCopy();
    const data = this.host.core.encodeKey(event);

    if (data.length === 0) return;
    this.suppressedKeyCodes.delete(event.code);
    event.preventDefault();
    event.stopPropagation();
    this.host.latencyCallbacks.onKeypress(data);
    this.host.options.onData(data);
  };

  readonly onKeyUp = (event: KeyboardEvent) => {
    this.host.updateLinkModifier(event);

    if (this.suppressedKeyCodes.delete(event.code)) return;

    if (isTerminalCompositionKey(event, this.composing)) {
      return;
    }

    // Ghostty's encoder only emits release codes when the terminal enabled the
    // Kitty report-event-types flag, so legacy sessions send nothing here.
    const data = this.host.core.encodeKey(event, "release");

    if (data.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.host.options.onData(data);
  };

  private primeCopy(selection: string): void {
    this.primedCopySelection = selection;
    primeTerminalCopyInput(this.host.input, selection);
  }

  clearPrimedCopy(): void {
    clearPrimedTerminalCopyInput(this.host.input, this.primedCopySelection);
    this.primedCopySelection = "";
  }

  readonly onCopyEvent = (event: ClipboardEvent) => {
    const selection = this.host.hasSelection() ? this.host.getSelection() : this.host.input.value;
    // Menu-role Copy never hits the keydown primer. The native action reads
    // this.host.input, so park the current selection first — including when
    // clipboardData is missing and we must not preventDefault.
    this.primeCopy(selection);
    const result = applyTerminalCopyEvent(selection, event.clipboardData);

    if (result.preventDefault) event.preventDefault();

    if (result.claimWriteFallback) {
      // The native event actually wrote the selection; drop the in-flight
      // writeText so a late resolution cannot clobber a later user copy.
      this.copyShortcutToken += 1;

      if (this.clearSelectionAfterCopy) {
        this.clearSelectionAfterCopy = false;
        this.host.clearSelection();
      }
    }
  };

  readonly onPaste = (event: ClipboardEvent) => {
    // Always suppress the browser's default insertion: content the textarea
    // would receive (for example an html-only clipboard converted to text)
    // leaks through onInput without bracketed-paste encoding.
    event.preventDefault();
    const data = event.clipboardData?.getData("text/plain") ?? "";

    if (data.length === 0) return;
    // The native paste won the race with actual text; a pending clipboard read
    // must not double. An empty native paste leaves the read as the only path.
    this.pasteShortcutToken += 1;
    this.host.options.onData(this.host.core.encodePaste(data));
  };

  readonly onCompositionStart = () => {
    this.clearPrimedCopy();
    this.clearCompositionInputSuppression();
    this.composing = true;
  };

  readonly onCompositionEnd = (event: CompositionEvent) => {
    this.composing = false;
    const data = this.host.input.value || event.data;

    if (data.length > 0) this.host.options.onData(data);
    this.host.input.value = "";
    this.compositionInputToSuppress = data;
    this.compositionSuppressionTimer = window.setTimeout(() => {
      this.compositionInputToSuppress = null;
      this.compositionSuppressionTimer = null;
    }, 100);
  };

  readonly onInput = (event: Event) => {
    const inputEvent = event as InputEvent;

    if (this.composing || inputEvent.isComposing) return;
    const data = this.host.input.value || inputEvent.data || "";

    if (data === this.compositionInputToSuppress && isTerminalCompositionCommitInput(inputEvent)) {
      this.clearCompositionInputSuppression();
      this.host.input.value = "";

      return;
    }

    this.clearCompositionInputSuppression();

    if (data.length > 0) this.host.options.onData(data);
    this.host.input.value = "";
  };

  private clearCompositionInputSuppression(): void {
    if (this.compositionSuppressionTimer !== null) {
      window.clearTimeout(this.compositionSuppressionTimer);
      this.compositionSuppressionTimer = null;
    }

    this.compositionInputToSuppress = null;
  }
}
