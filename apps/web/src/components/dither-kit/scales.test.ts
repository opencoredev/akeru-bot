import { describe, expect, it } from "vite-plus/test";

import { computeBands } from "./scales";

describe("computeBands", () => {
  it("stacks series on the preceding band's upper edge", () => {
    expect(computeBands([{ a: 2, b: 3 }], ["a", "b"], "stacked")).toEqual({
      bands: { a: [[0, 2]], b: [[2, 5]] },
      min: 0,
      max: 5,
    });
  });
});
