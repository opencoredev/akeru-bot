import * as Match from "effect/Match";
import {
  type GhosttyKeyboardLayoutMap,
  ghosttyConsumedMods,
  ghosttyKeyForCode,
  ghosttyUnshiftedCodepoint,
} from "./keyCodes";
import { GhosttyRuntime } from "./runtime";
import {
  assertGhosttySuccess,
  GHOSTTY_SUCCESS,
  GHOSTTY_OUT_OF_SPACE,
  type GhosttyMouseInput,
} from "./coreTypes";

const decoder = new TextDecoder();

const encoder = new TextEncoder();

/**
 * Owns the libghostty-vt key and mouse encoders for one terminal and turns
 * browser keyboard, mouse, and paste input into the bytes the PTY expects.
 * The terminal core creates it during initialization and disposes it first.
 */
export class GhosttyInputEncoder {
  private keyEncoderSlot = 0;
  private keyEncoder = 0;
  private keyEventSlot = 0;
  private keyEvent = 0;
  private mouseEncoderSlot = 0;
  private mouseEncoder = 0;
  private mouseEventSlot = 0;
  private mouseEvent = 0;

  constructor(
    private readonly runtime: GhosttyRuntime,
    private readonly terminal: number,
    private readonly scratch: number,
  ) {}

  initialize(): void {
    this.keyEncoderSlot = this.runtime.allocOpaque();
    assertGhosttySuccess(
      "ghostty_key_encoder_new",
      this.runtime.call("ghostty_key_encoder_new", 0, this.keyEncoderSlot),
    );
    this.keyEncoder = this.runtime.readPointer(this.keyEncoderSlot);
    this.keyEventSlot = this.runtime.allocOpaque();
    assertGhosttySuccess(
      "ghostty_key_event_new",
      this.runtime.call("ghostty_key_event_new", 0, this.keyEventSlot),
    );
    this.keyEvent = this.runtime.readPointer(this.keyEventSlot);

    this.mouseEncoderSlot = this.runtime.allocOpaque();
    assertGhosttySuccess(
      "ghostty_mouse_encoder_new",
      this.runtime.call("ghostty_mouse_encoder_new", 0, this.mouseEncoderSlot),
    );
    this.mouseEncoder = this.runtime.readPointer(this.mouseEncoderSlot);
    this.mouseEventSlot = this.runtime.allocOpaque();
    assertGhosttySuccess(
      "ghostty_mouse_event_new",
      this.runtime.call("ghostty_mouse_event_new", 0, this.mouseEventSlot),
    );
    this.mouseEvent = this.runtime.readPointer(this.mouseEventSlot);
  }

  encodeKey(
    event: KeyboardEvent,
    action: "press" | "release",
    keyboardLayoutMap: GhosttyKeyboardLayoutMap | undefined,
  ): string {
    this.runtime.call("ghostty_key_encoder_setopt_from_terminal", this.keyEncoder, this.terminal);
    this.runtime.call(
      "ghostty_key_event_set_action",
      this.keyEvent,
      action === "release" ? 0 : event.repeat ? 2 : 1,
    );
    this.runtime.call("ghostty_key_event_set_key", this.keyEvent, ghosttyKeyForCode(event.code));

    const mods =
      (event.shiftKey ? 1 : 0) |
      (event.ctrlKey ? 1 << 1 : 0) |
      (event.altKey ? 1 << 2 : 0) |
      (event.metaKey ? 1 << 3 : 0) |
      (event.getModifierState("CapsLock") ? 1 << 4 : 0) |
      (event.getModifierState("NumLock") ? 1 << 5 : 0);

    this.runtime.call("ghostty_key_event_set_mods", this.keyEvent, mods);
    this.runtime.call(
      "ghostty_key_event_set_consumed_mods",
      this.keyEvent,
      ghosttyConsumedMods(event),
    );
    this.runtime.call("ghostty_key_event_set_composing", this.keyEvent, event.isComposing ? 1 : 0);
    this.runtime.call(
      "ghostty_key_event_set_unshifted_codepoint",
      this.keyEvent,
      ghosttyUnshiftedCodepoint(event, keyboardLayoutMap),
    );

    const text = event.key.length === 1 ? event.key : "";
    const textBytes = encoder.encode(text);
    const textPointer = textBytes.length === 0 ? 0 : this.runtime.alloc(textBytes.length);

    if (textPointer !== 0) this.runtime.bytes(textPointer, textBytes.length).set(textBytes);
    this.runtime.call("ghostty_key_event_set_utf8", this.keyEvent, textPointer, textBytes.length);

    const written = this.runtime.call("ghostty_wasm_alloc_usize");

    const encoded = this.encodeOutput(written, (output, outputSize) =>
      this.runtime.call(
        "ghostty_key_encoder_encode",
        this.keyEncoder,
        this.keyEvent,
        output,
        outputSize,
        written,
      ),
    );

    this.runtime.call("ghostty_wasm_free_usize", written);

    if (textPointer !== 0) this.runtime.free(textPointer, textBytes.length);

    return encoded;
  }

  encodePaste(data: string): string {
    const input = encoder.encode(data);

    if (input.length === 0) return "";
    const inputPointer = this.runtime.alloc(input.length);
    this.runtime.bytes(inputPointer, input.length).set(input);
    this.runtime.bytes(this.scratch, 1)[0] = 0;

    const bracketed =
      this.runtime.call("ghostty_terminal_mode_get", this.terminal, 2004, this.scratch) ===
        GHOSTTY_SUCCESS && this.runtime.bytes(this.scratch, 1)[0] !== 0;

    const written = this.runtime.call("ghostty_wasm_alloc_usize");
    let encoded = "";

    const sizeResult = this.runtime.call(
      "ghostty_paste_encode",
      inputPointer,
      input.length,
      bracketed ? 1 : 0,
      0,
      0,
      written,
    );

    const outputSize = this.runtime.view(written, 4).getUint32(0, true);

    if (sizeResult === GHOSTTY_OUT_OF_SPACE && outputSize > 0) {
      const output = this.runtime.alloc(outputSize);

      const result = this.runtime.call(
        "ghostty_paste_encode",
        inputPointer,
        input.length,
        bracketed ? 1 : 0,
        output,
        outputSize,
        written,
      );

      const outputLength = this.runtime.view(written, 4).getUint32(0, true);
      encoded =
        result === GHOSTTY_SUCCESS ? decoder.decode(this.runtime.bytes(output, outputLength)) : "";
      this.runtime.free(output, outputSize);
    }

    this.runtime.call("ghostty_wasm_free_usize", written);
    this.runtime.free(inputPointer, input.length);

    return encoded;
  }

  encodeMouse(input: GhosttyMouseInput): string {
    this.runtime.call(
      "ghostty_mouse_encoder_setopt_from_terminal",
      this.mouseEncoder,
      this.terminal,
    );

    const sizeLayout = this.runtime.layout("GhosttyMouseEncoderSize");
    const size = this.runtime.alloc(sizeLayout.size);

    for (const [field, value] of [
      ["size", sizeLayout.size],
      ["screen_width", input.screenWidth],
      ["screen_height", input.screenHeight],
      ["cell_width", input.cellWidth],
      ["cell_height", input.cellHeight],
      ["padding_top", input.paddingTop],
      ["padding_bottom", input.paddingBottom],
      ["padding_right", input.paddingRight],
      ["padding_left", input.paddingLeft],
    ] as const) {
      this.runtime.setField(size, "GhosttyMouseEncoderSize", field, Math.max(0, Math.round(value)));
    }

    this.runtime.call("ghostty_mouse_encoder_setopt", this.mouseEncoder, 2, size);
    this.runtime.free(size, sizeLayout.size);

    this.runtime.bytes(this.scratch, 1)[0] = input.anyButtonPressed ? 1 : 0;
    this.runtime.call("ghostty_mouse_encoder_setopt", this.mouseEncoder, 3, this.scratch);
    this.runtime.bytes(this.scratch, 1)[0] = 1;
    this.runtime.call("ghostty_mouse_encoder_setopt", this.mouseEncoder, 4, this.scratch);

    this.runtime.call(
      "ghostty_mouse_event_set_action",
      this.mouseEvent,
      Match.value(input.action).pipe(
        Match.when("press", () => 0),
        Match.when("release", () => 1),
        Match.orElse(() => 2),
      ),
    );

    if (input.button === null) {
      this.runtime.call("ghostty_mouse_event_clear_button", this.mouseEvent);
    } else {
      this.runtime.call("ghostty_mouse_event_set_button", this.mouseEvent, input.button);
    }

    this.runtime.call("ghostty_mouse_event_set_mods", this.mouseEvent, input.mods);
    const positionLayout = this.runtime.layout("GhosttyMousePosition");
    const position = this.runtime.alloc(positionLayout.size);
    const positionView = this.runtime.view(position, positionLayout.size);
    positionView.setFloat32(positionLayout.fields.x!.offset, input.x, true);
    positionView.setFloat32(positionLayout.fields.y!.offset, input.y, true);
    this.runtime.call("ghostty_mouse_event_set_position", this.mouseEvent, position);
    this.runtime.free(position, positionLayout.size);

    const written = this.runtime.call("ghostty_wasm_alloc_usize");

    const encoded = this.encodeOutput(written, (output, outputSize) =>
      this.runtime.call(
        "ghostty_mouse_encoder_encode",
        this.mouseEncoder,
        this.mouseEvent,
        output,
        outputSize,
        written,
      ),
    );

    this.runtime.call("ghostty_wasm_free_usize", written);

    return encoded;
  }

  dispose(): void {
    if (this.mouseEvent) this.runtime.call("ghostty_mouse_event_free", this.mouseEvent);

    if (this.mouseEncoder) this.runtime.call("ghostty_mouse_encoder_free", this.mouseEncoder);

    if (this.keyEvent) this.runtime.call("ghostty_key_event_free", this.keyEvent);

    if (this.keyEncoder) this.runtime.call("ghostty_key_encoder_free", this.keyEncoder);

    for (const slot of [
      this.mouseEventSlot,
      this.mouseEncoderSlot,
      this.keyEventSlot,
      this.keyEncoderSlot,
    ]) {
      this.runtime.freeOpaque(slot);
    }
  }

  private encodeOutput(
    written: number,
    encode: (output: number, outputSize: number) => number,
  ): string {
    const sizeResult = encode(0, 0);
    const outputSize = this.runtime.view(written, 4).getUint32(0, true);

    if (sizeResult === GHOSTTY_SUCCESS && outputSize === 0) return "";

    if (sizeResult !== GHOSTTY_OUT_OF_SPACE || outputSize === 0) return "";

    const output = this.runtime.alloc(outputSize);
    const result = encode(output, outputSize);
    const outputLength = this.runtime.view(written, 4).getUint32(0, true);

    const encoded =
      result === GHOSTTY_SUCCESS ? decoder.decode(this.runtime.bytes(output, outputLength)) : "";

    this.runtime.free(output, outputSize);

    return encoded;
  }
}
