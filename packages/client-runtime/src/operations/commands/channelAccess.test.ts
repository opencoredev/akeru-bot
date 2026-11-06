import { ChannelLinkCode } from "@akeru/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { channelLinkCodeFromBytes } from "./channelAccess.ts";

describe("channelLinkCodeFromBytes", () => {
  it("builds a code the server accepts from any byte values", () => {
    const isLinkCode = Schema.is(ChannelLinkCode);

    for (const bytes of [
      new Uint8Array(8),
      new Uint8Array(8).fill(255),
      Uint8Array.from([0, 31, 32, 63, 127, 128, 200, 254]),
    ]) {
      expect(isLinkCode(channelLinkCodeFromBytes(bytes))).toBe(true);
    }
  });

  it("never uses look-alike characters", () => {
    const code = channelLinkCodeFromBytes(Uint8Array.from({ length: 8 }, (_, index) => index * 33));

    expect(code).toMatch(/^[^01IO]{8}$/u);
  });
});
