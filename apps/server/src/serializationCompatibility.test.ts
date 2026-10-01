import { describe, expect, it } from "@effect/vitest";
import { canonicalJson, canonicalValue } from "./portabilityChecksums.ts";
import { encodeMemoryArchiveJson } from "./memory/MemoryArchiveJson.ts";
import { stripDefaultServerSettings } from "./serverSettingsPersistence.ts";

describe("opaque metadata serialization", () => {
  it("preserves non-finite metadata until JSON serialization", () => {
    const metadata = {
      z: [Number.POSITIVE_INFINITY, undefined],
      a: { z: Number.NaN, a: Number.NEGATIVE_INFINITY },
      omitted: undefined,
    };

    expect(canonicalValue(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(canonicalJson(metadata)).toBe('{"a":{"a":null,"z":null},"z":[null,null]}');
    expect(encodeMemoryArchiveJson(metadata)).toBe('{"a":{"a":null,"z":null},"z":[null,null]}');
    expect(stripDefaultServerSettings(metadata, { z: [], a: { z: 0, a: 0 } })).toEqual({
      z: [Number.POSITIVE_INFINITY, undefined],
      a: { z: Number.NaN, a: Number.NEGATIVE_INFINITY },
    });
  });
});
