import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PortabilityGroupData } from "./portability.ts";

const decodePortabilityGroupData = Schema.decodeUnknownEffect(PortabilityGroupData);

it.effect("rejects person memberships in portable group records", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodePortabilityGroupData({
        name: "Product",
        bossBotId: "bot-1",
        members: [{ kind: "person", personId: "person-1", role: "specialist" }],
      }),
    );

    assert.strictEqual(result._tag, "Failure");
  }),
);
