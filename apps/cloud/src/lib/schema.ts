import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

type Decodable = Schema.Top & { readonly DecodingServices: never };

/** Decodes an unknown value, returning `null` instead of throwing on invalid input. */
export function decodeOrNull<S extends Decodable>(
  schema: S,
  value: Schema.Schema.Type<typeof Schema.Unknown>,
): S["Type"] | null {
  const exit = Schema.decodeUnknownExit(schema)(value);

  return Exit.isSuccess(exit) ? exit.value : null;
}

/**
 * Parses a JSON request body and decodes it. Requires `content-type:
 * application/json`, which a cross-site form cannot send without a CORS preflight.
 */
export async function decodeJsonBody<S extends Decodable>(
  request: Request,
  schema: S,
): Promise<S["Type"] | null> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.split(";")[0]!.trim().toLowerCase() !== "application/json") return null;

  try {
    return decodeOrNull(schema, await request.json());
  } catch {
    return null;
  }
}
