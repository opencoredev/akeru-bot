import { describe, expect, it } from "vite-plus/test";

import { DELEGATION_DRIVER_KINDS, driverSupportsDelegation } from "./delegationProviders.ts";

describe("driverSupportsDelegation", () => {
  it("allows the controller drivers and refuses the legacy bridge", () => {
    for (const driverKind of DELEGATION_DRIVER_KINDS) {
      expect(driverSupportsDelegation(driverKind)).toBe(true);
    }
    expect(driverSupportsDelegation("opencode")).toBe(false);
    expect(driverSupportsDelegation("unknown")).toBe(false);
  });
});
