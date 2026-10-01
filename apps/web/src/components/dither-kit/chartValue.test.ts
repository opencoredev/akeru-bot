import { describe, expect, it } from "vite-plus/test";
import { chartRows } from "./chartValue";

describe("chart mark identity", () => {
  it("keeps each row's key when categories move or values change", () => {
    const first = { name: "First", value: 1 };
    const second = { name: "Second", value: 2 };
    const before = chartRows([first, second]);
    first.value = 10;
    const after = chartRows([second, first]);

    expect(after.map((mark) => mark.key)).toEqual(before.map((mark) => mark.key).toReversed());
    expect(after.map((mark) => mark.index)).toEqual([0, 1]);
    expect(after.map((mark) => mark.row.value)).toEqual([2, 10]);
  });

  it("gives repeated rows and equal-valued rows distinct, repeatable keys", () => {
    const row = { value: 1 };
    const data = [row, row, { value: 1 }];
    const keys = chartRows(data).map((mark) => mark.key);

    expect(new Set(keys).size).toBe(3);
    expect(chartRows(data).map((mark) => mark.key)).toEqual(keys);
  });
});
