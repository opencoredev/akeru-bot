import { describe, expect, it } from "vite-plus/test";
import { ghosttyKeyForCode } from "./keyCodes";
import { makeGhosttyAbiFixture } from "./runtimeAbi.test-support";

describe("Ghostty ABI keyboard", () => {
  it("encodes modified printable keys in Kitty keyboard mode", async () => {
    const { memory, call, alloc, free, createTerminal } = await makeGhosttyAbiFixture();

    const { terminal, dispose } = createTerminal(80, 24);
    const kittyMode = new TextEncoder().encode("\u001b[>1u");
    const kittyModePointer = alloc(kittyMode.length);
    new Uint8Array(memory.buffer, kittyModePointer, kittyMode.length).set(kittyMode);
    call("ghostty_terminal_vt_write", terminal, kittyModePointer, kittyMode.length);

    const encoderSlot = call("ghostty_wasm_alloc_opaque");
    const eventSlot = call("ghostty_wasm_alloc_opaque");
    expect(call("ghostty_key_encoder_new", 0, encoderSlot)).toBe(0);
    expect(call("ghostty_key_event_new", 0, eventSlot)).toBe(0);
    const view = new DataView(memory.buffer);
    const keyEncoder = view.getUint32(encoderSlot, true);
    const keyEvent = view.getUint32(eventSlot, true);
    call("ghostty_key_encoder_setopt_from_terminal", keyEncoder, terminal);
    call("ghostty_key_event_set_action", keyEvent, 1);
    call("ghostty_key_event_set_key", keyEvent, ghosttyKeyForCode("KeyC"));
    call("ghostty_key_event_set_mods", keyEvent, 1 << 1);
    call("ghostty_key_event_set_consumed_mods", keyEvent, 0);
    call("ghostty_key_event_set_composing", keyEvent, 0);
    call("ghostty_key_event_set_unshifted_codepoint", keyEvent, "c".codePointAt(0)!);
    const text = new TextEncoder().encode("c");
    const textPointer = alloc(text.length);
    new Uint8Array(memory.buffer, textPointer, text.length).set(text);
    call("ghostty_key_event_set_utf8", keyEvent, textPointer, text.length);

    const written = call("ghostty_wasm_alloc_usize");
    expect(call("ghostty_key_encoder_encode", keyEncoder, keyEvent, 0, 0, written)).toBe(-3);
    const outputSize = new DataView(memory.buffer, written, 4).getUint32(0, true);
    const output = alloc(outputSize);
    expect(
      call("ghostty_key_encoder_encode", keyEncoder, keyEvent, output, outputSize, written),
    ).toBe(0);
    const outputLength = new DataView(memory.buffer, written, 4).getUint32(0, true);
    expect(new TextDecoder().decode(new Uint8Array(memory.buffer, output, outputLength))).toBe(
      "\u001b[99;5u",
    );

    const remappedText = new TextEncoder().encode("j");
    const remappedTextPointer = alloc(remappedText.length);
    new Uint8Array(memory.buffer, remappedTextPointer, remappedText.length).set(remappedText);
    call("ghostty_key_event_set_unshifted_codepoint", keyEvent, "j".codePointAt(0)!);
    call("ghostty_key_event_set_utf8", keyEvent, remappedTextPointer, remappedText.length);
    expect(call("ghostty_key_encoder_encode", keyEncoder, keyEvent, 0, 0, written)).toBe(-3);
    const remappedOutputSize = new DataView(memory.buffer, written, 4).getUint32(0, true);
    const remappedOutput = alloc(remappedOutputSize);
    expect(
      call(
        "ghostty_key_encoder_encode",
        keyEncoder,
        keyEvent,
        remappedOutput,
        remappedOutputSize,
        written,
      ),
    ).toBe(0);
    const remappedOutputLength = new DataView(memory.buffer, written, 4).getUint32(0, true);
    expect(
      new TextDecoder().decode(new Uint8Array(memory.buffer, remappedOutput, remappedOutputLength)),
    ).toBe("\u001b[106;5u");

    // Without the Kitty report-event-types flag a release encodes nothing, so
    // the surface's keyup handler stays silent for legacy sessions.
    call("ghostty_key_event_set_action", keyEvent, 0);
    expect(call("ghostty_key_encoder_encode", keyEncoder, keyEvent, 0, 0, written)).toBe(0);
    expect(new DataView(memory.buffer, written, 4).getUint32(0, true)).toBe(0);

    // With report-event-types enabled the same release encodes an event-typed code.
    const reportEvents = new TextEncoder().encode("\u001b[>3u");
    const reportEventsPointer = alloc(reportEvents.length);
    new Uint8Array(memory.buffer, reportEventsPointer, reportEvents.length).set(reportEvents);
    call("ghostty_terminal_vt_write", terminal, reportEventsPointer, reportEvents.length);
    call("ghostty_key_encoder_setopt_from_terminal", keyEncoder, terminal);
    expect(call("ghostty_key_encoder_encode", keyEncoder, keyEvent, 0, 0, written)).toBe(-3);
    const releaseSize = new DataView(memory.buffer, written, 4).getUint32(0, true);
    const releaseOutput = alloc(releaseSize);
    expect(
      call("ghostty_key_encoder_encode", keyEncoder, keyEvent, releaseOutput, releaseSize, written),
    ).toBe(0);
    const releaseLength = new DataView(memory.buffer, written, 4).getUint32(0, true);
    expect(
      new TextDecoder().decode(new Uint8Array(memory.buffer, releaseOutput, releaseLength)),
    ).toBe("\u001b[106;5:3u");
    free(releaseOutput, releaseSize);
    free(reportEventsPointer, reportEvents.length);

    free(remappedOutput, remappedOutputSize);
    free(remappedTextPointer, remappedText.length);
    free(output, outputSize);
    call("ghostty_wasm_free_usize", written);
    free(textPointer, text.length);
    call("ghostty_key_event_free", keyEvent);
    call("ghostty_key_encoder_free", keyEncoder);
    call("ghostty_wasm_free_opaque", eventSlot);
    call("ghostty_wasm_free_opaque", encoderSlot);
    free(kittyModePointer, kittyMode.length);
    dispose();
  });
});
