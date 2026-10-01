import { describe, expect, it } from "vite-plus/test";
import wasmDataUrl from "./vendor/ghostty-vt.wasm?inline";
import pinnedVersion from "../../../../../native/libghostty-vt/VERSION?raw";
import { decodeWasmDataUrl, makeGhosttyAbiFixture } from "./runtimeAbi.test-support";

describe("Ghostty ABI lifecycle", () => {
  it("stays pinned to the canonical revision and size budget", async () => {
    const wasm = decodeWasmDataUrl(wasmDataUrl);
    expect(wasm.byteLength).toBeLessThan(750_000);

    // The artifact carries its own provenance: the build embeds the pinned
    // revision as semver build metadata, so the repository's canonical VERSION
    // file is the single source of truth and drift is caught here without a copy.
    const { memory, call } = await makeGhosttyAbiFixture();
    const out = call("ghostty_wasm_alloc_u8_array", 8);
    expect(call("ghostty_build_info", 10, out)).toBe(0);
    const view = new DataView(memory.buffer, out, 8);
    const embeddedRevision = new TextDecoder().decode(
      new Uint8Array(memory.buffer, view.getUint32(0, true), view.getUint32(4, true)),
    );
    call("ghostty_wasm_free_u8_array", out, 8);
    expect(embeddedRevision).toBe(pinnedVersion.trim());
  });

  it("creates, writes multi-codepoint graphemes, and frees repeated terminals", async () => {
    const { memory, call } = await makeGhosttyAbiFixture();
    const jsonPointer = call("ghostty_type_json");
    const jsonBytes = new Uint8Array(memory.buffer, jsonPointer);
    const jsonEnd = jsonBytes.indexOf(0);
    const layouts = JSON.parse(new TextDecoder().decode(jsonBytes.subarray(0, jsonEnd))) as Record<
      string,
      { size: number }
    >;
    const optionsSize = layouts.GhosttyTerminalOptions?.size;
    expect(optionsSize).toBe(8);
    if (optionsSize === undefined) throw new Error("GhosttyTerminalOptions layout is missing");

    for (let iteration = 0; iteration < 25; iteration += 1) {
      const options = call("ghostty_wasm_alloc_u8_array", optionsSize);
      const optionsView = new DataView(memory.buffer, options, optionsSize);
      optionsView.setUint16(0, 80, true);
      optionsView.setUint16(2, 24, true);
      optionsView.setUint32(4, 5_000, true);
      const terminalSlot = call("ghostty_wasm_alloc_opaque");
      expect(call("ghostty_terminal_new", 0, terminalSlot, options)).toBe(0);
      const terminal = new DataView(memory.buffer).getUint32(terminalSlot, true);

      const input = new TextEncoder().encode("e\u0301 👨‍👩‍👧‍👦 العربية\r\n");
      const inputPointer = call("ghostty_wasm_alloc_u8_array", input.length);
      new Uint8Array(memory.buffer, inputPointer, input.length).set(input);
      call("ghostty_terminal_vt_write", terminal, inputPointer, input.length);
      call("ghostty_wasm_free_u8_array", inputPointer, input.length);
      call("ghostty_terminal_free", terminal);
      call("ghostty_wasm_free_opaque", terminalSlot);
      call("ghostty_wasm_free_u8_array", options, optionsSize);
    }
  });
});
