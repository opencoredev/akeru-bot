import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Keep each valid stored field when adjacent fields are missing or malformed. */
export function storedField<S extends Schema.Top>(schema: S, fallback: NoInfer<S["Type"]>) {
  const recovered = Schema.catchDecoding<S>(() => Effect.succeed(Option.some(fallback)))(schema);

  return Schema.withDecodingDefaultType<typeof recovered>(Effect.succeed(fallback))(recovered);
}
