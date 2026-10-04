import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useThemeColor } from "./useThemeColor";

const mocks = vi.hoisted(() => ({
  useCSSVariable: vi.fn<(variable: string) => string | undefined>(),
}));

vi.mock("uniwind", () => ({ useCSSVariable: mocks.useCSSVariable }));

describe("useThemeColor", () => {
  beforeEach(() => mocks.useCSSVariable.mockReset());

  it("returns undefined for the missing memory editor placeholder token", () => {
    expect(useThemeColor("--color-foreground-subtle")).toBeUndefined();
    expect(mocks.useCSSVariable).toHaveBeenCalledWith("--color-foreground-subtle");
  });

  it("returns a defined theme color unchanged", () => {
    mocks.useCSSVariable.mockReturnValue("#123456");
    expect(useThemeColor("--color-icon")).toBe("#123456");
  });
});
