import { describe, expect, it } from "vite-plus/test";
import { asRecord, asTrimmedString, projectBoundedValue } from "./ActivityPayloadBounds.ts";

describe("activity payload probes", () => {
  it("excludes arrays and non-objects", () => {
    for (const value of [null, undefined, [], "text", 42, true]) {
      expect(asRecord(value)).toBeNull();
    }
  });

  it("reads request IDs without inspecting discarded descendants", () => {
    const payload = {
      requestId: "request-1",
      get discarded() {
        throw new Error("Discarded field was read");
      },
    };

    expect(asTrimmedString(asRecord(payload)?.requestId)).toBe("request-1");
  });

  it("narrows individual fields before reading strings or projecting objects", () => {
    expect(asTrimmedString({ unexpected: true })).toBeNull();
    expect(projectBoundedValue(() => "unexpected")).toEqual({});
  });
});
