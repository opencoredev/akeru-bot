import { useEffect, useState } from "react";

import { api, EmptyResponse, ApiError, type GetToken, PendingLink } from "../api.ts";

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "missing" }
  | { readonly kind: "pending"; readonly link: PendingLink }
  | { readonly kind: "done"; readonly approved: boolean }
  | { readonly kind: "error" };

export function LinkPage({ getToken }: { getToken: GetToken }) {
  const code = new URLSearchParams(window.location.search).get("code") ?? "";
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api(getToken, `/api/link?code=${encodeURIComponent(code)}`, PendingLink)
      .then((link) => setState({ kind: "pending", link }))
      .catch((cause: unknown) =>
        setState(
          cause instanceof ApiError && cause.status === 404
            ? { kind: "missing" }
            : { kind: "error" },
        ),
      );
  }, [code, getToken]);

  const decide = async (approve: boolean) => {
    if (state.kind !== "pending") return;
    setBusy(true);

    try {
      await api(getToken, `/api/link/${approve ? "approve" : "deny"}`, EmptyResponse, {
        method: "POST",
        body: { userCode: state.link.userCode },
      });
      setState({ kind: "done", approved: approve });
    } catch {
      setState({ kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  switch (state.kind) {
    case "loading":
      return null;
    case "missing":
      return (
        <main>
          <h2>Code not found</h2>
          <p className="muted">
            This code expired or was already used. Start linking again in Akeru Bot.
          </p>
        </main>
      );
    case "error":
      return <p className="error">Something went wrong. Try again.</p>;
    case "done":
      return (
        <main>
          <h2>{state.approved ? "Linked" : "Not linked"}</h2>
          <p className="muted">
            {state.approved
              ? "Akeru Bot finishes setup on its own. You can close this tab."
              : "Nothing was linked. You can close this tab."}
          </p>
        </main>
      );
    case "pending":
      return (
        <main>
          <h2>Link {state.link.environmentName}?</h2>
          <p className="muted">
            Akeru Bot {state.link.serverVersion} on this computer will connect to your Akeru Cloud
            account. Only link a computer you set up yourself.
          </p>
          <p className="code">{state.link.userCode}</p>
          <p className="muted small">Check that this code matches the one Akeru Bot shows.</p>
          <div className="actions">
            <button type="button" className="primary" disabled={busy} onClick={() => decide(true)}>
              Link
            </button>
            <button type="button" disabled={busy} onClick={() => decide(false)}>
              Deny
            </button>
          </div>
        </main>
      );
  }
}
