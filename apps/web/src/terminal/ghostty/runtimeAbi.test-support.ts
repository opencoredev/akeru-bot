import * as Schema from "effect/Schema";

import wasmDataUrl from "./vendor/ghostty-vt.wasm?inline";

const decodeWasmResult = Schema.decodeUnknownSync(Schema.UndefinedOr(Schema.Number));
export function decodeWasmDataUrl(dataUrl: string) {
  const encoded = dataUrl.split(",", 2)[1];

  if (!encoded) throw new Error("The vendored Ghostty WASM data URL is invalid");

  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}

export async function makeGhosttyAbiFixture() {
  const wasm = decodeWasmDataUrl(wasmDataUrl);
  const { instance } = await WebAssembly.instantiate(wasm, { env: { log: () => {} } });
  const memory = instance.exports.memory;

  if (!(memory instanceof WebAssembly.Memory)) throw new Error("Ghostty memory is missing");

  const call = (name: string, ...args: number[]) => {
    const callable = instance.exports[name];

    if (typeof callable !== "function") throw new Error(`Ghostty export ${name} is missing`);
    const result: unknown = callable(...args);

    return decodeWasmResult(result) ?? 0;
  };

  const alloc = (size: number) => call("ghostty_wasm_alloc_u8_array", size);
  const free = (pointer: number, size: number) => call("ghostty_wasm_free_u8_array", pointer, size);

  const createTerminal = (cols: number, rows: number, scrollback = 0) => {
    const options = alloc(8);
    const view = new DataView(memory.buffer, options, 8);
    view.setUint16(0, cols, true);
    view.setUint16(2, rows, true);
    view.setUint32(4, scrollback, true);
    const slot = call("ghostty_wasm_alloc_opaque");
    const result = call("ghostty_terminal_new", 0, slot, options);

    if (result !== 0) throw new Error(`Ghostty terminal creation failed: ${result}`);
    const terminal = new DataView(memory.buffer).getUint32(slot, true);

    return {
      terminal,
      dispose: () => {
        call("ghostty_terminal_free", terminal);
        call("ghostty_wasm_free_opaque", slot);
        free(options, 8);
      },
    };
  };

  return { wasm, instance, memory, call, alloc, free, createTerminal };
}
