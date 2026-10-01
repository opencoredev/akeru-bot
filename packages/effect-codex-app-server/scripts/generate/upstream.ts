import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { GeneratorError } from "./errors.ts";

export const UPSTREAM_REF = "678157acaa819d5510adfe359abb5d0392cfe461";

const USER_AGENT = "effect-codex-app-server-generator";

const GITHUB_API_BASE =
  "https://api.github.com/repos/openai/codex/contents/codex-rs/app-server-protocol";

const GithubContentEntries = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    path: Schema.String,
    download_url: Schema.NullOr(Schema.String),
    type: Schema.String,
  }),
);

export type GithubContentEntry = (typeof GithubContentEntries.Type)[number];

const JsonSchemaDocument = Schema.StructWithRest(
  Schema.Struct({
    definitions: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

const decodeGithubContentEntries = Schema.decodeEffect(Schema.fromJsonString(GithubContentEntries));

export const decodeJsonSchemaDocument = Schema.decodeEffect(
  Schema.fromJsonString(JsonSchemaDocument),
);

export const fetchText = Effect.fn("fetchText")(function* (url: string) {
  return yield* HttpClientRequest.get(url).pipe(
    HttpClientRequest.setHeader("user-agent", USER_AGENT),
    HttpClient.execute,
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((okResponse) => okResponse.text),
    Effect.mapError(
      (cause) =>
        new GeneratorError({
          detail: `Failed to fetch ${url}`,
          cause,
        }),
    ),
  );
});

export const fetchDirectoryEntries = Effect.fn("fetchDirectoryEntries")(function* (path: string) {
  const raw = yield* fetchText(`${GITHUB_API_BASE}/${path}?ref=${UPSTREAM_REF}`);
  return yield* decodeGithubContentEntries(raw);
});

export function collectSchemaEntries(
  chunk: string,
): ReadonlyArray<{ readonly name: string; readonly code: string }> {
  const lines = chunk
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"));
  const entries: Array<{ name: string; code: string }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const typeLine = lines[index];
    if (!typeLine?.startsWith("export type ")) {
      continue;
    }

    const constLine = lines[index + 1];
    if (!constLine?.startsWith("export const ")) {
      throw new Error(`Malformed generator output near: ${typeLine}`);
    }

    const match = /^export type ([A-Za-z0-9_]+)/.exec(typeLine);
    if (!match?.[1]) {
      throw new Error(`Could not extract schema name from: ${typeLine}`);
    }

    entries.push({
      name: match[1],
      code: `${typeLine}\n${constLine}`,
    });
    index += 1;
  }

  return entries;
}
