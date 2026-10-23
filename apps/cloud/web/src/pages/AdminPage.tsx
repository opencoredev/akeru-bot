import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";

import { api, ApiError, formatTime, type GetToken } from "../api.ts";

const Overview = Schema.Struct({
  totals: Schema.Struct({
    users: Schema.Number,
    environments: Schema.Number,
    routes: Schema.Number,
  }),
  users: Schema.Array(
    Schema.Struct({
      userId: Schema.String,
      email: Schema.String,
      createdAt: Schema.String,
      disabled: Schema.Boolean,
      environments: Schema.Number,
      routes: Schema.Number,
    }),
  ),
  environments: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      serverVersion: Schema.String,
      email: Schema.String,
      createdAt: Schema.String,
      lastSeenAt: Schema.NullOr(Schema.String),
      revokedAt: Schema.NullOr(Schema.String),
    }),
  ),
  routes: Schema.Array(
    Schema.Struct({
      routeId: Schema.String,
      provider: Schema.String,
      label: Schema.String,
      workspaceName: Schema.NullOr(Schema.String),
      email: Schema.String,
      lastEventAt: Schema.NullOr(Schema.String),
      disabled: Schema.Boolean,
      delivered: Schema.Number,
      dropped: Schema.Number,
    }),
  ),
  usage: Schema.Array(
    Schema.Struct({ day: Schema.String, delivered: Schema.Number, dropped: Schema.Number }),
  ),
});

type Overview = typeof Overview.Type;

export function AdminPage({ getToken }: { getToken: GetToken }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api(getToken, "/api/admin/overview", Overview)
      .then(setOverview)
      .catch((cause: unknown) =>
        setError(
          cause instanceof ApiError && cause.status === 403 ? "Admins only." : "Couldn't load.",
        ),
      );
  }, [getToken]);

  if (error) return <p className="error">{error}</p>;

  if (!overview) return null;
  const { totals } = overview;

  return (
    <main className="admin">
      <p className="muted">
        {totals.users} users · {totals.environments} linked computers · {totals.routes} active
        hosted bots
      </p>

      <h2>Events, last 7 days</h2>
      <table>
        <thead>
          <tr>
            <th>Day</th>
            <th>Delivered</th>
            <th>Dropped</th>
          </tr>
        </thead>
        <tbody>
          {overview.usage.map((row) => (
            <tr key={row.day}>
              <td>{row.day}</td>
              <td>{row.delivered}</td>
              <td>{row.dropped}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Users</h2>
      <table>
        <thead>
          <tr>
            <th>Email</th>
            <th>Joined</th>
            <th>Computers</th>
            <th>Bots</th>
          </tr>
        </thead>
        <tbody>
          {overview.users.map((user) => (
            <tr key={user.userId}>
              <td>
                {user.email}
                {user.disabled ? " (disabled)" : ""}
              </td>
              <td>{formatTime(user.createdAt)}</td>
              <td>{user.environments}</td>
              <td>{user.routes}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Computers</h2>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Owner</th>
            <th>Version</th>
            <th>Last seen</th>
          </tr>
        </thead>
        <tbody>
          {overview.environments.map((environment) => (
            <tr key={environment.id}>
              <td>
                {environment.name}
                {environment.revokedAt ? " (unlinked)" : ""}
              </td>
              <td>{environment.email}</td>
              <td>{environment.serverVersion}</td>
              <td>{formatTime(environment.lastSeenAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Hosted bots</h2>
      <table>
        <thead>
          <tr>
            <th>Bot</th>
            <th>Owner</th>
            <th>Workspace</th>
            <th>Last event</th>
            <th>7-day delivered / dropped</th>
          </tr>
        </thead>
        <tbody>
          {overview.routes.map((route) => (
            <tr key={route.routeId}>
              <td>
                {route.label} ({route.provider}){route.disabled ? " (off)" : ""}
              </td>
              <td>{route.email}</td>
              <td>{route.workspaceName ?? ""}</td>
              <td>{formatTime(route.lastEventAt)}</td>
              <td>
                {route.delivered} / {route.dropped}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
