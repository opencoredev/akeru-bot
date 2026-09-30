import { describe, expect, it } from "vite-plus/test";

import type { RelayRouteBinding } from "@t3tools/contracts";

import {
  validateRelayAttachment,
  validateRelayEnrollmentSecret,
  validateRelayRouteBinding,
} from "./relay.ts";

const expected: RelayRouteBinding = {
  protocolVersion: "1",
  routeId: "route-a",
  environmentId: "environment-a" as RelayRouteBinding["environmentId"],
};

describe("relay validation", () => {
  it("accepts the matching protocol, route, and environment", () => {
    expect(validateRelayRouteBinding({ offered: expected, expected })).toEqual({ ok: true });
  });

  it.each([
    ["protocolVersion", { protocolVersion: "2" }],
    ["routeId", { routeId: "route-b" }],
    ["environmentId", { environmentId: "environment-b" }],
  ] as const)("rejects a changed %s", (_field, change) => {
    const offered = { ...expected, ...change } as RelayRouteBinding;
    expect(validateRelayRouteBinding({ offered, expected })).toEqual({
      ok: false,
      reason:
        _field === "protocolVersion"
          ? "unsupported-protocol"
          : _field === "routeId"
            ? "route-mismatch"
            : "environment-mismatch",
    });
  });

  it("keeps enrollment secrets separate from session credentials", () => {
    expect(validateRelayEnrollmentSecret({ provided: "enroll-a", expected: "enroll-a" })).toEqual({
      ok: true,
    });
    expect(
      validateRelayEnrollmentSecret({ provided: "pairing-token", expected: "enroll-a" }),
    ).toEqual({ ok: false, reason: "enrollment-secret-mismatch" });
    expect(validateRelayEnrollmentSecret({ provided: undefined, expected: "enroll-a" })).toEqual({
      ok: false,
      reason: "missing-enrollment-secret",
    });
  });

  it("rejects wrong environments before accepting a valid secret", () => {
    const result = validateRelayAttachment({
      offered: {
        ...expected,
        environmentId: "environment-b" as RelayRouteBinding["environmentId"],
      },
      expected,
      enrollmentSecret: "enroll-a",
      expectedEnrollmentSecret: "enroll-a",
    });
    expect(result).toEqual({ ok: false, reason: "environment-mismatch" });
    expect(JSON.stringify(result)).not.toContain("enroll-a");
  });
});
