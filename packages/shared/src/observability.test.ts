import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import {
  causeErrorTag,
  compactTraceAttributes,
  errorTag,
  runtimeValueType,
  truncateTraceAttributes,
} from "./observability.ts";

describe("runtimeValueType", () => {
  it.each([
    [undefined, "undefined"],
    [null, "object"],
    ["text", "string"],
    [1, "number"],
    [Number.NaN, "number"],
    [true, "boolean"],
    [1n, "bigint"],
    [Symbol("value"), "symbol"],
    [() => undefined, "function"],
    [[], "object"],
    [{ _tag: "TaggedError" }, "object"],
    [new TypeError("message"), "object"],
  ])("reports the JavaScript category of %s", (value, expected) => {
    assert.equal(runtimeValueType(value), expected);
  });
});

describe("errorTag", () => {
  it("reports structural tags without retaining arbitrary values", () => {
    assert.equal(errorTag({ _tag: "AcpRequestError" }), "AcpRequestError");
    assert.equal(errorTag(new TypeError("secret-token-value")), "TypeError");
    assert.equal(errorTag({ _tag: "secret token value" }), "TaggedError");
  });
});

describe("causeErrorTag", () => {
  it("reports the tagged failure value instead of the Cause reason wrapper", () => {
    assert.equal(
      causeErrorTag(Cause.fail({ _tag: "ServerAuthInvalidCredentialError" })),
      "ServerAuthInvalidCredentialError",
    );
  });

  it("reports structural cause kinds when no typed failure exists", () => {
    assert.equal(causeErrorTag(Cause.die(new Error("unexpected"))), "Die");
    assert.equal(causeErrorTag(Cause.interrupt()), "Interrupt");
  });
});

describe("truncateTraceAttributes", () => {
  it("clamps oversized strings at any depth without mutating the input", () => {
    const stack = "s".repeat(2_000);

    const attributes = {
      "db.query.text": "q".repeat(2_000),
      short: "ok",
      error: { name: "Error", stack, nested: ["a".repeat(2_000)] },
    };

    const truncated = truncateTraceAttributes(attributes);

    assert.equal((truncated["db.query.text"] as string).length, 200 + "…[truncated]".length);
    assert.equal(truncated["short"], "ok");
    const error = truncated["error"] as { stack: string; nested: Array<string> };
    assert.equal(error.stack.length, 500 + "…[truncated]".length);
    assert.equal(error.nested[0]?.length, 500 + "…[truncated]".length);
    // Input is untouched: the live span's attributes are shared.
    assert.equal(attributes.error.stack, stack);
  });

  it("returns the same reference when nothing exceeds the limits", () => {
    const attributes = { short: "ok", nested: { fine: "also ok" } };
    assert.equal(truncateTraceAttributes(attributes), attributes);
  });
});

describe("observability", () => {
  it("normalizes circular arrays, maps, and sets without recursing forever", () => {
    const array: Array<unknown> = ["alpha"];
    array.push(array);

    const map = new Map<string, unknown>();
    map.set("self", map);

    const set = new Set<unknown>();
    set.add(set);

    assert.deepStrictEqual(
      compactTraceAttributes({
        array,
        map,
        set,
      }),
      {
        array: ["alpha", "[Circular]"],
        map: { self: "[Circular]" },
        set: ["[Circular]"],
      },
    );
  });

  it("normalizes invalid dates without throwing", () => {
    // @effect-diagnostics-next-line globalDate:off
    const invalidDate = new Date("not-a-real-date");
    assert.deepStrictEqual(
      compactTraceAttributes({
        invalidDate,
      }),
      {
        invalidDate: "Invalid Date",
      },
    );
  });
});
