import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { AuthEnvironmentScopes } from "./auth.ts";

const decodeScopes = Schema.decodeUnknownSync(AuthEnvironmentScopes);
const decodeStoredScopes = Schema.decodeUnknownSync(Schema.fromJsonString(AuthEnvironmentScopes));

describe("AuthEnvironmentScopes", () => {
  it("drops the retired review:write and terminal:operate scopes from older sessions and tokens", () => {
    expect(
      decodeScopes([
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "review:write",
      ]),
    ).toEqual(["orchestration:read", "orchestration:operate"]);
  });

  it("drops retired scopes stored as JSON", () => {
    expect(decodeStoredScopes('["review:write","terminal:operate","access:read"]')).toEqual([
      "access:read",
    ]);
  });

  it("still rejects unknown scopes", () => {
    expect(() => decodeScopes(["orchestration:read", "admin:everything"])).toThrow();
  });
});
