import type { CloudDatabase } from "./database.ts";
import type { Hono } from "hono";

import type { Analytics } from "./analytics.ts";
import type { CloudConfig } from "./config.ts";
import type { HubDirectory } from "./modules/environments/hubRpc.ts";

export interface AuthenticatedUser {
  readonly userId: string;
  readonly email: string;
  readonly isAdmin: boolean;
}

export interface Authenticator {
  /** Resolves the signed-in browser user, or null when the request carries no valid session. */
  readonly authenticate: (request: Request) => Promise<AuthenticatedUser | null>;
}

/** Everything a request handler needs. The Worker builds it from its env; tests pass fakes. */
export interface CloudDeps {
  readonly db: CloudDatabase;
  readonly hubs: HubDirectory;
  readonly auth: Authenticator;
  readonly analytics: Analytics;
  readonly config: CloudConfig;
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}

export type CloudHono = Hono<{ Bindings: CloudDeps; Variables: { user: AuthenticatedUser } }>;
