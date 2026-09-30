import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Body decoded as text, or `""` for bodiless requests. */
  readonly body: string;
  /** Body parsed as JSON, or `undefined` when it is not JSON. */
  readonly json: unknown;
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/**
 * A test HttpClient that answers each request from `reply` and records it.
 * `reply` returns a Web `Response`, or an Effect of one to delay or fail.
 * Provide `client` with `Effect.provideService(HttpClient.HttpClient, client)`.
 */
export function scriptedHttpClient(
  reply: (request: RecordedRequest, index: number) => Response | Effect.Effect<Response>,
) {
  const requests: Array<RecordedRequest> = [];
  const client = HttpClient.make((request) =>
    Effect.suspend(() => {
      const body =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      const recorded: RecordedRequest = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
        json: Option.getOrUndefined(decodeJson(body)),
      };
      requests.push(recorded);
      const response = reply(recorded, requests.length - 1);
      return (Effect.isEffect(response) ? response : Effect.succeed(response)).pipe(
        Effect.map((web) => HttpClientResponse.fromWeb(request, web)),
      );
    }),
  );
  return { client, requests };
}

/** Build an unsigned JWT whose payload is `claims`. */
export function fakeJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}
