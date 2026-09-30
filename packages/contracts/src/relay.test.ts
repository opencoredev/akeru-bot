import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { RelayAttachRequest, RelayProtocolVersion } from "./relay.ts";

const decode = Schema.decodeUnknownSync(RelayAttachRequest);

describe("relay contract", () => {
  it("decodes a version one attach request", () => {
    expect(
      decode({
        binding: { protocolVersion: "1", routeId: "route-a", environmentId: "environment-a" },
        enrollmentSecret: "enroll-a",
      }),
    ).toEqual({
      binding: { protocolVersion: "1", routeId: "route-a", environmentId: "environment-a" },
      enrollmentSecret: "enroll-a",
    });
  });

  it("rejects unknown protocol versions and missing enrollment secrets", () => {
    expect(() => Schema.decodeUnknownSync(RelayProtocolVersion)("2")).toThrow();
    expect(() =>
      decode({
        binding: { protocolVersion: "1", routeId: "route-a", environmentId: "environment-a" },
      }),
    ).toThrow();
  });
});
