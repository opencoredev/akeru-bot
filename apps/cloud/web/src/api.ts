import * as Schema from "effect/Schema";

export const Me = Schema.Struct({
  account: Schema.Struct({ email: Schema.String, isAdmin: Schema.Boolean }),
  environments: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      serverVersion: Schema.String,
      createdAt: Schema.String,
      lastSeenAt: Schema.NullOr(Schema.String),
      status: Schema.Literals(["online", "offline", "revoked"]),
    }),
  ),
  routes: Schema.Array(
    Schema.Struct({
      routeId: Schema.String,
      provider: Schema.String,
      environmentId: Schema.String,
      label: Schema.String,
      workspaceName: Schema.NullOr(Schema.String),
      createdAt: Schema.String,
      lastEventAt: Schema.NullOr(Schema.String),
      disabled: Schema.Boolean,
    }),
  ),
});

export type Me = typeof Me.Type;

export const PendingLink = Schema.Struct({
  userCode: Schema.String,
  environmentName: Schema.String,
  serverVersion: Schema.String,
  expiresAt: Schema.String,
});

export type PendingLink = typeof PendingLink.Type;

export const EmptyResponse = Schema.Struct({ ok: Schema.optionalKey(Schema.Boolean) });

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Request failed with ${status}`);
    this.status = status;
  }
}

export type GetToken = () => Promise<string | null>;

/** Calls the same-origin browser API with the Clerk session token. */
export async function api<S extends Schema.Top & { readonly DecodingServices: never }>(
  getToken: GetToken,
  path: string,
  schema: S,
  init: { method?: "GET" | "POST"; body?: object } = {},
): Promise<S["Type"]> {
  const token = await getToken();

  const response = await fetch(path, {
    method: init.method ?? "GET",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

  if (!response.ok) throw new ApiError(response.status);

  return Schema.decodeUnknownSync(schema)(await response.json());
}

export function formatTime(iso: string | null): string {
  if (!iso) return "Never";

  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
