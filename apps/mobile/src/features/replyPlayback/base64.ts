import { toByteArray } from "base64-js";

export function decodeReplyAudioBase64(value: string): Uint8Array {
  return toByteArray(value);
}
