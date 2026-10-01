import { describe, expect, it } from "vite-plus/test";
import { makeGhosttyAbiFixture } from "./runtimeAbi.test-support";

describe("Ghostty ABI selection", () => {
  it("formats the active selection with Ghostty's copy semantics", async () => {
    const { memory, call, createTerminal } = await makeGhosttyAbiFixture();
    const { terminal, dispose } = createTerminal(80, 24);
    const input = new TextEncoder().encode("a\r\n\r\nb");
    const inputPointer = call("ghostty_wasm_alloc_u8_array", input.length);
    new Uint8Array(memory.buffer, inputPointer, input.length).set(input);
    call("ghostty_terminal_vt_write", terminal, inputPointer, input.length);

    const selection = call("ghostty_wasm_alloc_u8_array", 32);
    new DataView(memory.buffer, selection, 32).setUint32(0, 32, true);
    expect(call("ghostty_terminal_select_all", terminal, selection)).toBe(0);
    expect(call("ghostty_terminal_set", terminal, 21, selection)).toBe(0);
    const formatOptions = call("ghostty_wasm_alloc_u8_array", 16);
    const formatView = new DataView(memory.buffer, formatOptions, 16);
    formatView.setUint32(0, 16, true);
    formatView.setUint8(8, 1);
    formatView.setUint8(9, 1);
    const written = call("ghostty_wasm_alloc_usize");
    expect(
      call("ghostty_terminal_selection_format_buf", terminal, formatOptions, 0, 0, written),
    ).toBe(-3);
    const outputSize = new DataView(memory.buffer, written, 4).getUint32(0, true);
    const output = call("ghostty_wasm_alloc_u8_array", outputSize);
    expect(
      call(
        "ghostty_terminal_selection_format_buf",
        terminal,
        formatOptions,
        output,
        outputSize,
        written,
      ),
    ).toBe(0);
    expect(new TextDecoder().decode(new Uint8Array(memory.buffer, output, outputSize))).toBe(
      "a\n\nb",
    );

    call("ghostty_wasm_free_u8_array", output, outputSize);
    call("ghostty_wasm_free_usize", written);
    call("ghostty_wasm_free_u8_array", formatOptions, 16);
    call("ghostty_wasm_free_u8_array", selection, 32);
    call("ghostty_wasm_free_u8_array", inputPointer, input.length);
    dispose();
  });

  it("formats a cell-drag selection installed from screen grid refs", async () => {
    const { memory, call, alloc, free, createTerminal } = await makeGhosttyAbiFixture();
    const { terminal, dispose } = createTerminal(80, 24);
    const input = new TextEncoder().encode("hello\r\nworld");
    const inputPointer = alloc(input.length);
    new Uint8Array(memory.buffer, inputPointer, input.length).set(input);
    call("ghostty_terminal_vt_write", terminal, inputPointer, input.length);

    const gridRefAt = (x: number, y: number) => {
      const point = alloc(24);
      const pointView = new DataView(memory.buffer, point, 24);
      pointView.setUint32(0, 2, true);
      pointView.setUint16(8, x, true);
      pointView.setUint32(12, y, true);
      const ref = alloc(12);
      new DataView(memory.buffer, ref, 12).setUint32(0, 12, true);
      expect(call("ghostty_terminal_grid_ref", terminal, point, ref)).toBe(0);
      free(point, 24);
      return ref;
    };
    const start = gridRefAt(0, 0);
    const end = gridRefAt(4, 1);
    const selection = alloc(32);
    const selectionBytes = new Uint8Array(memory.buffer, selection, 32);
    selectionBytes.fill(0);
    new DataView(memory.buffer, selection, 32).setUint32(0, 32, true);
    selectionBytes.set(new Uint8Array(memory.buffer, start, 12), 4);
    selectionBytes.set(new Uint8Array(memory.buffer, end, 12), 16);
    expect(call("ghostty_terminal_set", terminal, 21, selection)).toBe(0);

    const formatOptions = alloc(16);
    new Uint8Array(memory.buffer, formatOptions, 16).fill(0);
    const formatView = new DataView(memory.buffer, formatOptions, 16);
    formatView.setUint32(0, 16, true);
    formatView.setUint8(8, 1);
    formatView.setUint8(9, 1);
    const written = call("ghostty_wasm_alloc_usize");
    expect(
      call("ghostty_terminal_selection_format_buf", terminal, formatOptions, 0, 0, written),
    ).toBe(-3);
    const outputSize = new DataView(memory.buffer, written, 4).getUint32(0, true);
    const output = alloc(outputSize);
    expect(
      call(
        "ghostty_terminal_selection_format_buf",
        terminal,
        formatOptions,
        output,
        outputSize,
        written,
      ),
    ).toBe(0);
    expect(new TextDecoder().decode(new Uint8Array(memory.buffer, output, outputSize))).toBe(
      "hello\nworld",
    );

    free(output, outputSize);
    call("ghostty_wasm_free_usize", written);
    free(formatOptions, 16);
    free(selection, 32);
    free(end, 12);
    free(start, 12);
    free(inputPointer, input.length);
    dispose();
  });

  it("uses Ghostty for mouse encoding, word selection, and OSC 8 hit testing", async () => {
    const { memory, call, alloc, free, createTerminal } = await makeGhosttyAbiFixture();

    const { terminal, dispose } = createTerminal(80, 24);
    const input = new TextEncoder().encode(
      "\u001b[?1000h\u001b[?1006h\u001b]8;;https://t3.codes/docs\u001b\\linked\u001b]8;;\u001b\\ plain",
    );
    const inputPointer = alloc(input.length);
    new Uint8Array(memory.buffer, inputPointer, input.length).set(input);
    call("ghostty_terminal_vt_write", terminal, inputPointer, input.length);

    const modeFlag = alloc(1);
    new Uint8Array(memory.buffer, modeFlag, 1)[0] = 0;
    expect(call("ghostty_terminal_get", terminal, 11, modeFlag)).toBe(0);
    expect(new Uint8Array(memory.buffer, modeFlag, 1)[0]).toBe(1);
    new Uint8Array(memory.buffer, modeFlag, 1)[0] = 1;
    expect(call("ghostty_terminal_mode_get", terminal, 1003, modeFlag)).toBe(0);
    expect(new Uint8Array(memory.buffer, modeFlag, 1)[0]).toBe(0);
    const anyEventInput = new TextEncoder().encode("\u001b[?1003h");
    const anyEventPointer = alloc(anyEventInput.length);
    new Uint8Array(memory.buffer, anyEventPointer, anyEventInput.length).set(anyEventInput);
    call("ghostty_terminal_vt_write", terminal, anyEventPointer, anyEventInput.length);
    expect(call("ghostty_terminal_mode_get", terminal, 1003, modeFlag)).toBe(0);
    expect(new Uint8Array(memory.buffer, modeFlag, 1)[0]).toBe(1);
    const anyEventReset = new TextEncoder().encode("\u001b[?1003l\u001b[?1000h");
    const anyEventResetPointer = alloc(anyEventReset.length);
    new Uint8Array(memory.buffer, anyEventResetPointer, anyEventReset.length).set(anyEventReset);
    call("ghostty_terminal_vt_write", terminal, anyEventResetPointer, anyEventReset.length);
    expect(call("ghostty_terminal_mode_get", terminal, 1003, modeFlag)).toBe(0);
    expect(new Uint8Array(memory.buffer, modeFlag, 1)[0]).toBe(0);
    free(anyEventResetPointer, anyEventReset.length);
    free(anyEventPointer, anyEventInput.length);
    free(modeFlag, 1);

    const point = alloc(24);
    const pointView = new DataView(memory.buffer, point, 24);
    pointView.setUint32(0, 1, true);
    pointView.setUint16(8, 1, true);
    pointView.setUint32(12, 0, true);
    const gridRef = alloc(12);
    new DataView(memory.buffer, gridRef, 12).setUint32(0, 12, true);
    expect(call("ghostty_terminal_grid_ref", terminal, point, gridRef)).toBe(0);

    const written = call("ghostty_wasm_alloc_usize");
    expect(call("ghostty_grid_ref_hyperlink_uri", gridRef, 0, 0, written)).toBe(-3);
    const hyperlinkSize = new DataView(memory.buffer, written, 4).getUint32(0, true);
    const hyperlink = alloc(hyperlinkSize);
    expect(call("ghostty_grid_ref_hyperlink_uri", gridRef, hyperlink, hyperlinkSize, written)).toBe(
      0,
    );
    expect(new TextDecoder().decode(new Uint8Array(memory.buffer, hyperlink, hyperlinkSize))).toBe(
      "https://t3.codes/docs",
    );

    const wordOptions = alloc(24);
    const wordOptionsView = new DataView(memory.buffer, wordOptions, 24);
    wordOptionsView.setUint32(0, 24, true);
    new Uint8Array(memory.buffer, wordOptions + 4, 12).set(
      new Uint8Array(memory.buffer, gridRef, 12),
    );
    const selection = alloc(32);
    new DataView(memory.buffer, selection, 32).setUint32(0, 32, true);
    expect(call("ghostty_terminal_select_word", terminal, wordOptions, selection)).toBe(0);
    expect(call("ghostty_terminal_set", terminal, 21, selection)).toBe(0);
    const formatOptions = alloc(16);
    const formatView = new DataView(memory.buffer, formatOptions, 16);
    formatView.setUint32(0, 16, true);
    formatView.setUint8(8, 1);
    formatView.setUint8(9, 1);
    expect(
      call("ghostty_terminal_selection_format_buf", terminal, formatOptions, 0, 0, written),
    ).toBe(-3);
    const selectionSize = new DataView(memory.buffer, written, 4).getUint32(0, true);
    const selectionText = alloc(selectionSize);
    expect(
      call(
        "ghostty_terminal_selection_format_buf",
        terminal,
        formatOptions,
        selectionText,
        selectionSize,
        written,
      ),
    ).toBe(0);
    expect(
      new TextDecoder().decode(new Uint8Array(memory.buffer, selectionText, selectionSize)),
    ).toBe("linked");

    const lineOptions = alloc(28);
    const lineOptionsView = new DataView(memory.buffer, lineOptions, 28);
    lineOptionsView.setUint32(0, 28, true);
    new Uint8Array(memory.buffer, lineOptions + 4, 12).set(
      new Uint8Array(memory.buffer, gridRef, 12),
    );
    expect(call("ghostty_terminal_select_line", terminal, lineOptions, selection)).toBe(0);
    expect(call("ghostty_terminal_set", terminal, 21, selection)).toBe(0);
    expect(
      call("ghostty_terminal_selection_format_buf", terminal, formatOptions, 0, 0, written),
    ).toBe(-3);
    const lineSelectionSize = new DataView(memory.buffer, written, 4).getUint32(0, true);
    const lineSelectionText = alloc(lineSelectionSize);
    expect(
      call(
        "ghostty_terminal_selection_format_buf",
        terminal,
        formatOptions,
        lineSelectionText,
        lineSelectionSize,
        written,
      ),
    ).toBe(0);
    expect(
      new TextDecoder().decode(new Uint8Array(memory.buffer, lineSelectionText, lineSelectionSize)),
    ).toBe("linked plain");

    const mouseEncoderSlot = call("ghostty_wasm_alloc_opaque");
    const mouseEventSlot = call("ghostty_wasm_alloc_opaque");
    expect(call("ghostty_mouse_encoder_new", 0, mouseEncoderSlot)).toBe(0);
    expect(call("ghostty_mouse_event_new", 0, mouseEventSlot)).toBe(0);
    const view = new DataView(memory.buffer);
    const mouseEncoder = view.getUint32(mouseEncoderSlot, true);
    const mouseEvent = view.getUint32(mouseEventSlot, true);
    call("ghostty_mouse_encoder_setopt_from_terminal", mouseEncoder, terminal);
    const mouseSize = alloc(36);
    const mouseSizeView = new DataView(memory.buffer, mouseSize, 36);
    for (const [offset, value] of [
      [0, 36],
      [4, 800],
      [8, 480],
      [12, 10],
      [16, 20],
    ] as const) {
      mouseSizeView.setUint32(offset, value, true);
    }
    call("ghostty_mouse_encoder_setopt", mouseEncoder, 2, mouseSize);
    call("ghostty_mouse_event_set_action", mouseEvent, 0);
    call("ghostty_mouse_event_set_button", mouseEvent, 1);
    const mousePosition = new DataView(new ArrayBuffer(8));
    mousePosition.setFloat32(0, 15, true);
    mousePosition.setFloat32(4, 25, true);
    const mousePositionPointer = alloc(8);
    new Uint8Array(memory.buffer, mousePositionPointer, 8).set(
      new Uint8Array(mousePosition.buffer),
    );
    call("ghostty_mouse_event_set_position", mouseEvent, mousePositionPointer);
    const mouseOutput = alloc(128);
    expect(
      call("ghostty_mouse_encoder_encode", mouseEncoder, mouseEvent, mouseOutput, 128, written),
    ).toBe(0);
    const mouseOutputSize = new DataView(memory.buffer, written, 4).getUint32(0, true);
    expect(
      new TextDecoder().decode(new Uint8Array(memory.buffer, mouseOutput, mouseOutputSize)),
    ).toBe("\u001b[<0;2;2M");

    call("ghostty_mouse_event_free", mouseEvent);
    call("ghostty_mouse_encoder_free", mouseEncoder);
    call("ghostty_wasm_free_opaque", mouseEventSlot);
    call("ghostty_wasm_free_opaque", mouseEncoderSlot);
    free(mousePositionPointer, 8);
    free(mouseOutput, 128);
    free(mouseSize, 36);
    free(lineSelectionText, lineSelectionSize);
    free(lineOptions, 28);
    free(selectionText, selectionSize);
    free(formatOptions, 16);
    free(selection, 32);
    free(wordOptions, 24);
    free(hyperlink, hyperlinkSize);
    call("ghostty_wasm_free_usize", written);
    free(gridRef, 12);
    free(point, 24);
    free(inputPointer, input.length);
    dispose();
  });
});
