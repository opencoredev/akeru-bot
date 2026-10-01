interface NestedInput {
  nested?: NestedInput;
}

import { describe, expect, it } from "vite-plus/test";

import { akeruActionNeedsApproval, criticalAkeruAction } from "./AkeruMastraHarness.ts";

describe("Akeru action inspection budget", () => {
  it("requires approval for large object arrays without overflowing the stack", () => {
    const args = Array.from({ length: 200_000 }, () => ({ operation: "read" }));

    expect(criticalAkeruAction("custom_tool", args)).toBeNull();
    expect(akeruActionNeedsApproval("custom_tool", args)).toBe(true);
  });

  it("requires approval when a wide object exceeds the property budget", () => {
    const args = Object.fromEntries(
      Array.from({ length: 200_000 }, (_, index) => [`field${index}`, "read"]),
    );

    expect(akeruActionNeedsApproval("custom_tool", args)).toBe(true);
  });

  it("shares the budget across nested arrays and object properties", () => {
    const args = { items: Array.from({ length: 60 }, () => ({ operation: "read" })) };

    expect(akeruActionNeedsApproval("custom_tool", args)).toBe(true);
  });

  it("fails closed on cycles", () => {
    const args: NestedInput = {};
    args.nested = args;

    expect(akeruActionNeedsApproval("custom_tool", args)).toBe(true);
  });

  it("still classifies ordinary nested sensitive paths and commands", () => {
    expect(criticalAkeruAction("custom_tool", { items: [{ path: "~/.ssh/id_rsa" }] })).toBe(
      "secrets",
    );
    expect(
      criticalAkeruAction("custom_tool", { nested: { command: "git push origin main" } }),
    ).toBe("publish");
    expect(
      akeruActionNeedsApproval("custom_tool", { nested: { operation: "read", path: "README.md" } }),
    ).toBe(false);
  });
});
