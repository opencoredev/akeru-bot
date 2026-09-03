import { describe, expect, it } from "vite-plus/test";
import { cn } from "./cn";

describe("cn", () => {
  it("joins conditional classes and resolves Tailwind conflicts", () => {
    const classesForState = (isActive: boolean) =>
      cn("px-2 text-black", isActive && "px-4", { "text-white": isActive, hidden: false });

    expect(classesForState(true)).toBe("px-4 text-white");
  });
});
