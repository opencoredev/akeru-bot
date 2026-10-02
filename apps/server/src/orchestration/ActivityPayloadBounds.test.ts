import * as NodeChildProcess from "node:child_process";
import { describe, expect, it } from "vite-plus/test";
import { asRecord, asTrimmedString, projectBoundedValue } from "./ActivityPayloadBounds.ts";

describe("activity payload probes", () => {
  it("copies bounded previews without retaining their source allocations", () => {
    const output = NodeChildProcess.execFileSync(
      process.execPath,
      [
        "--expose-gc",
        "--input-type=module",
        "-e",
        `
      import { randomBytes } from "node:crypto";
      import { projectBoundedValue } from ${JSON.stringify(new URL("./ActivityPayloadBounds.ts", import.meta.url).href)};
      for (let index = 0; index < 5; index++) globalThis.gc();
      const baseline = process.memoryUsage().external;
      const previews = [];
      const makePreview = () => projectBoundedValue(randomBytes(16 * 1024 * 1024).toString("hex"));
      for (let index = 0; index < 4; index++) {
        previews.push(makePreview());
      }
      for (let index = 0; index < 5; index++) globalThis.gc();
      const retained = process.memoryUsage().external - baseline;
      if (previews.length !== 4 || previews.some(preview => preview.length !== 4096)) throw new Error("Invalid previews");
      process.stdout.write(String(retained));
    `,
      ],
      { encoding: "utf8" },
    );

    expect(Number(output)).toBeLessThan(1024 * 1024);
  });

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
