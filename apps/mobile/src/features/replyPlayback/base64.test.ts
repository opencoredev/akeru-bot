import { describe, expect, it } from "vite-plus/test";
import { decodeReplyAudioBase64 } from "./base64";

describe("reply audio base64", () => {
  it("decodes without relying on atob", () => {
    const previous = globalThis.atob;
    Object.defineProperty(globalThis, "atob", { value: undefined, configurable: true });
    try {
      expect([...decodeReplyAudioBase64("AQID")]).toEqual([1, 2, 3]);
    } finally {
      Object.defineProperty(globalThis, "atob", { value: previous, configurable: true });
    }
  });
});
