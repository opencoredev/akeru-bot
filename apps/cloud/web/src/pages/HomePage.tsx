import { useCallback, useEffect, useState } from "react";

import { api, EmptyResponse, formatTime, type GetToken, Me } from "../api.ts";

export function HomePage({ getToken }: { getToken: GetToken }) {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api(getToken, "/api/me", Me)
      .then(setMe)
      .catch(() => setError("Couldn't load your account."));
  }, [getToken]);

  useEffect(load, [load]);

  const revoke = async (id: string, name: string) => {
    if (!window.confirm(`Unlink ${name}? Its hosted bots stop receiving messages.`)) return;

    try {
      await api(getToken, `/api/environments/${encodeURIComponent(id)}/revoke`, EmptyResponse, {
        method: "POST",
      });
      load();
    } catch {
      setError("Couldn't unlink that computer.");
    }
  };

  if (error) return <p className="error">{error}</p>;

  if (!me) return null;

  const environmentName = (id: string) =>
    me.environments.find((environment) => environment.id === id)?.name ?? "Unknown";

  return (
    <main>
      <p className="muted">
        Signed in as {me.account.email}
        {me.account.isAdmin ? (
          <>
            {" · "}
            <a href="/admin">Admin</a>
          </>
        ) : null}
      </p>

      <section>
        <h2>Linked computers</h2>
        {me.environments.length === 0 ? (
          <p className="muted">
            Nothing linked yet. In Akeru Bot, open Settings and link Akeru Cloud.
          </p>
        ) : (
          <ul className="list">
            {me.environments.map((environment) => (
              <li key={environment.id}>
                <div>
                  <strong>{environment.name}</strong>
                  <span className={`status status-${environment.status}`}>
                    {environment.status}
                  </span>
                  <p className="muted small">
                    Akeru Bot {environment.serverVersion} · last seen{" "}
                    {formatTime(environment.lastSeenAt)}
                  </p>
                </div>
                {environment.status === "revoked" ? null : (
                  <button type="button" onClick={() => revoke(environment.id, environment.name)}>
                    Unlink
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Hosted bots</h2>
        {me.routes.length === 0 ? (
          <p className="muted">No hosted bots. Connect a bot to Slack in Akeru Bot to add one.</p>
        ) : (
          <ul className="list">
            {me.routes.map((route) => (
              <li key={route.routeId}>
                <div>
                  <strong>{route.label}</strong>
                  <span className="status">{route.provider}</span>
                  {route.disabled ? <span className="status status-revoked">off</span> : null}
                  <p className="muted small">
                    {route.workspaceName ? `${route.workspaceName} · ` : ""}
                    on {environmentName(route.environmentId)} · last event{" "}
                    {formatTime(route.lastEventAt)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
