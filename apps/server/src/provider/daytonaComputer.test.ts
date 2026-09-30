import { PNG } from "pngjs";
import { describe, expect, it } from "vite-plus/test";
import { DaytonaComputer } from "./daytonaComputer.ts";

function png() {
  const image = new PNG({ width: 2, height: 2 });
  image.data.fill(255);
  return PNG.sync.write(image).toString("base64");
}

describe("DaytonaComputer", () => {
  it("redacts and bounds screenshots before returning a frame", async () => {
    const screenshot = png();
    const sandbox = {
      computerUse: {
        screenshot: { takeCompressed: async () => ({ screenshot }) },
        display: { getInfo: async () => ({ displays: [{ width: 2, height: 2 }] }) },
      },
    } as never;
    const frame = await new DaytonaComputer(sandbox).capture();
    expect(frame.mimeType).toBe("image/png");
    expect(frame.data).not.toBe(screenshot);
    expect(Buffer.from(frame.data, "base64").byteLength).toBeLessThan(256 * 1024);
  });
});
