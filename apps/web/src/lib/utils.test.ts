import { describe, assert, it } from "vite-plus/test";
import { cn, getLocalFileManagerName, isWindowsPlatform } from "./utils";

describe("cn", () => {
  it("joins conditional classes and resolves Tailwind conflicts", () => {
    const classesForState = (isActive: boolean) =>
      cn("px-2 text-black", isActive && "px-4", { "text-white": isActive, hidden: false });

    assert.strictEqual(classesForState(true), "px-4 text-white");
  });
});

describe("getLocalFileManagerName", () => {
  it.each([
    ["MacIntel", "Finder"],
    ["Win32", "Explorer"],
    ["Linux", "Files"],
  ])("uses the %s file manager name", (platform, expected) => {
    assert.strictEqual(getLocalFileManagerName(platform), expected);
  });
});

describe("isWindowsPlatform", () => {
  it("matches Windows platform identifiers", () => {
    assert.isTrue(isWindowsPlatform("Win32"));
    assert.isTrue(isWindowsPlatform("Windows"));
    assert.isTrue(isWindowsPlatform("windows_nt"));
  });

  it("does not match darwin", () => {
    assert.isFalse(isWindowsPlatform("darwin"));
  });
});
