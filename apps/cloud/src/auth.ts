import { createClerkClient } from "@clerk/backend";
import { createMiddleware } from "hono/factory";

import type { AuthenticatedUser, Authenticator, CloudDeps } from "./deps.ts";

export function createClerkAuthenticator(options: {
  readonly secretKey: string;
  readonly publishableKey: string;
  readonly publicUrl: string;
}): Authenticator {
  const clerk = createClerkClient({
    secretKey: options.secretKey,
    publishableKey: options.publishableKey,
  });

  return {
    authenticate: async (request) => {
      // Only the bearer token counts. Clerk would otherwise fall back to its
      // session cookie, which a cross-site form post also carries.
      const authorization = request.headers.get("authorization");

      if (!authorization) return null;
      const headerOnly = new Request(request.url, { headers: { authorization } });

      const state = await clerk.authenticateRequest(headerOnly, {
        authorizedParties: [new URL(options.publicUrl).origin],
      });

      if (!state.isAuthenticated) return null;
      const { userId } = state.toAuth();
      const user = await clerk.users.getUser(userId);

      const email =
        user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? null;

      if (!email) return null;

      return { userId, email, isAdmin: user.publicMetadata.role === "admin" };
    },
  };
}

/**
 * Records the user on first sight and keeps the stored email current.
 * Returns false when the account is disabled.
 */
async function upsertUser(deps: CloudDeps, user: AuthenticatedUser): Promise<boolean> {
  const inserted = await deps.db
    .prepare(
      "INSERT INTO users (clerk_user_id, email, created_at) VALUES (?, ?, ?) ON CONFLICT(clerk_user_id) DO NOTHING",
    )
    .bind(user.userId, user.email, deps.now().toISOString())
    .run();

  if (inserted.meta.changes === 1) {
    deps.analytics.capture("signed_up", user.userId);

    return true;
  }

  const row = await deps.db
    .prepare("SELECT email, disabled FROM users WHERE clerk_user_id = ?")
    .bind(user.userId)
    .first<{ email: string; disabled: number }>();

  if (row && row.email !== user.email) {
    await deps.db
      .prepare("UPDATE users SET email = ? WHERE clerk_user_id = ?")
      .bind(user.email, user.userId)
      .run();
  }

  return row?.disabled !== 1;
}

type AuthEnv = { Bindings: CloudDeps; Variables: { user: AuthenticatedUser } };

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Browser API guard. Requires a Clerk session and an enabled account. State
 * changes must carry the session as `Authorization: Bearer`, which a cross-site
 * request cannot set, so cookie-only requests are rejected.
 */
export const requireUser = createMiddleware<AuthEnv>(async (c, next) => {
  if (!SAFE_METHODS.has(c.req.method) && !/^Bearer \S/.test(c.req.header("authorization") ?? "")) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const user = await c.env.auth.authenticate(c.req.raw);

  if (!user) return c.json({ error: "unauthorized" }, 401);

  if (!(await upsertUser(c.env, user))) return c.json({ error: "disabled" }, 403);
  c.set("user", user);
  await next();
});

/** Admin is Clerk `publicMetadata.role === "admin"`. Use after `requireUser`. */
export const requireAdmin = createMiddleware<AuthEnv>(async (c, next) => {
  if (!c.get("user").isAdmin) return c.json({ error: "forbidden" }, 403);
  await next();
});
