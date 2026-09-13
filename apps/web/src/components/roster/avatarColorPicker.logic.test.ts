import { describe, expect, it } from "vite-plus/test";

import {
  clampColorFraction,
  formatColorFieldValueText,
  hexToHsv,
  hsvToHex,
} from "./avatarColorPicker.logic";

describe("avatar color picker", () => {
  it("round trips custom hex colors through HSV", () => {
    const hsv = hexToHsv("#17B890");

    expect(hsv).not.toBeNull();
    expect(hsvToHex(hsv!)).toBe("#17B890");
  });

  it("accepts hex without a hash and rejects invalid colors", () => {
    expect(hexToHsv("17b890")).not.toBeNull();
    expect(hexToHsv("rainbow")).toBeNull();
    expect(hexToHsv("#1234")).toBeNull();
  });

  it("clamps pointer coordinates to the picker bounds", () => {
    expect(clampColorFraction(-0.5)).toBe(0);
    expect(clampColorFraction(0.4)).toBe(0.4);
    expect(clampColorFraction(1.5)).toBe(1);
  });

  it("announces both dimensions of the saturation and brightness field", () => {
    expect(formatColorFieldValueText({ h: 240, s: 0.75, v: 0.4 }, "#191966")).toBe(
      "Saturation 75%, brightness 40%, #191966",
    );
  });
});
