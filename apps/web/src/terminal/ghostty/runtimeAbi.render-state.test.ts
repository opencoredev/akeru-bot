import { describe, expect, it } from "vite-plus/test";
import { makeGhosttyAbiFixture } from "./runtimeAbi.test-support";

describe("Ghostty ABI render-state", () => {
  it("blinks the default cursor until a program asks for a steady one", async () => {
    const { memory, call, alloc, createTerminal } = await makeGhosttyAbiFixture();
    const { terminal, dispose } = createTerminal(80, 24, 0);
    const renderStateSlot = call("ghostty_wasm_alloc_opaque");
    expect(call("ghostty_render_state_new", 0, renderStateSlot)).toBe(0);
    const renderState = new DataView(memory.buffer).getUint32(renderStateSlot, true);
    const scratch = alloc(4);

    const blinking = () => {
      expect(call("ghostty_render_state_update", renderState, terminal)).toBe(0);
      expect(call("ghostty_render_state_get", renderState, 12, scratch)).toBe(0);
      return new DataView(memory.buffer, scratch, 4).getUint8(0) !== 0;
    };
    const write = (data: string) => {
      const bytes = new TextEncoder().encode(data);
      const pointer = alloc(bytes.length);
      new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes);
      call("ghostty_terminal_vt_write", terminal, pointer, bytes.length);
      call("ghostty_wasm_free_u8_array", pointer, bytes.length);
    };
    const setDefaultCursorBlink = (blink: boolean) => {
      const value = alloc(1);
      new Uint8Array(memory.buffer, value, 1)[0] = blink ? 1 : 0;
      expect(call("ghostty_terminal_set", terminal, 23, value)).toBe(0);
      call("ghostty_wasm_free_u8_array", value, 1);
    };

    // Ghostty's own default is a steady cursor, so the blink the web terminal
    // inherited from xterm.js only exists because option 23 asks for it.
    expect(blinking()).toBe(false);
    setDefaultCursorBlink(true);
    expect(blinking()).toBe(true);

    // Programs still own the cursor: DECSCUSR steady block and DEC mode 12 both
    // stop the blink, and DECSCUSR reset returns to the embedder default.
    write("\u001b[2 q");
    expect(blinking()).toBe(false);
    write("\u001b[0 q");
    expect(blinking()).toBe(true);
    write("\u001b[?12l");
    expect(blinking()).toBe(false);
    write("\u001b[?12h");
    expect(blinking()).toBe(true);

    // RIS restores Ghostty's built-in steady default rather than the embedder's,
    // which is why the core reapplies the option around a session replay.
    call("ghostty_terminal_reset", terminal);
    expect(blinking()).toBe(false);
    setDefaultCursorBlink(true);
    expect(blinking()).toBe(true);

    call("ghostty_wasm_free_u8_array", scratch, 4);
    call("ghostty_render_state_free", renderState);
    call("ghostty_wasm_free_opaque", renderStateSlot);
    dispose();
  });

  it("reports and scrolls the viewport with Ghostty's scrollbar state", async () => {
    const { memory, call, alloc, createTerminal } = await makeGhosttyAbiFixture();
    const { terminal, dispose } = createTerminal(80, 10, 1_000);
    const input = new TextEncoder().encode(
      Array.from({ length: 50 }, (_, index) => `${index + 1}\r\n`).join(""),
    );
    const inputPointer = alloc(input.length);
    new Uint8Array(memory.buffer, inputPointer, input.length).set(input);
    call("ghostty_terminal_vt_write", terminal, inputPointer, input.length);

    const scrollbar = alloc(24);
    const scrollbarView = new DataView(memory.buffer, scrollbar, 24);
    expect(call("ghostty_terminal_get", terminal, 9, scrollbar)).toBe(0);
    expect([0, 8, 16].map((offset) => Number(scrollbarView.getBigUint64(offset, true)))).toEqual([
      51, 41, 10,
    ]);

    const scroll = alloc(24);
    const scrollView = new DataView(memory.buffer, scroll, 24);
    scrollView.setUint32(0, 2, true);
    scrollView.setInt32(8, -5, true);
    call("ghostty_terminal_scroll_viewport", terminal, scroll);
    expect(call("ghostty_terminal_get", terminal, 9, scrollbar)).toBe(0);
    expect(Number(scrollbarView.getBigUint64(8, true))).toBe(36);

    call("ghostty_wasm_free_u8_array", scroll, 24);
    call("ghostty_wasm_free_u8_array", scrollbar, 24);
    call("ghostty_wasm_free_u8_array", inputPointer, input.length);
    dispose();
  });
});
