import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ComposioConnection,
  ComposioConnectionStatus,
  ComposioToolkit,
  EnvironmentId,
} from "@t3tools/contracts";
import { useDeferredValue, useEffect, useState } from "react";
import type { PluginDirectoryDefinition } from "../../../../../plugins";
import { ensureLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { ComposioToolkitResults } from "./PluginsCatalog";

export const COMPOSIO_API_KEYS_URL = "https://app.composio.dev/settings/api-keys";
export const COMPOSIO_MIN_SEARCH_LENGTH = 2;

const CONNECTION_STATUS_LABELS: Record<ComposioConnectionStatus, string> = {
  ACTIVE: "Connected",
  INITIALIZING: "Waiting for sign-in",
  INITIATED: "Waiting for sign-in",
  FAILED: "Sign-in failed",
  EXPIRED: "Expired",
  INACTIVE: "Inactive",
  REVOKED: "Revoked",
};

export function composioConnectionLabel(status: ComposioConnectionStatus): string {
  return CONNECTION_STATUS_LABELS[status];
}

/**
 * Toolkit hits that can connect through Composio. Directory entries brokered by
 * Composio (Gmail) keep their own verification blocker, so search never offers
 * a second way around it.
 */
export function composioSearchResults(
  toolkits: readonly ComposioToolkit[],
  catalog: readonly PluginDirectoryDefinition[],
): readonly ComposioToolkit[] {
  const brokered = new Set(
    catalog.filter((plugin) => plugin.connection.type === "brokered").map((plugin) => plugin.id),
  );
  return toolkits.filter((toolkit) => !brokered.has(toolkit.slug));
}

export function activeComposioToolkitIds(
  connections: readonly ComposioConnection[],
): ReadonlySet<string> {
  return new Set(
    connections
      .filter((connection) => connection.status === "ACTIVE")
      .map((connection) => connection.toolkitSlug),
  );
}

/** Account rows for a configured key: one per Composio connection, with its own disconnect. */
export function ComposioAccounts({
  connections,
  pendingId,
  onDisconnect,
}: {
  readonly connections: readonly ComposioConnection[];
  readonly pendingId: string | null;
  readonly onDisconnect: (connection: ComposioConnection) => void;
}) {
  if (connections.length === 0) {
    return (
      <p className="text-[13px] text-muted-foreground">
        No accounts connected yet. Search above to find an app, then connect it.
      </p>
    );
  }
  return (
    <ul aria-label="Composio accounts" className="flex flex-col gap-1">
      {connections.map((connection) => (
        <li
          className="flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2"
          data-composio-connection={connection.id}
          key={connection.id}
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">
              {connection.alias ?? connection.toolkitSlug}
            </p>
            <p className="text-xs text-muted-foreground">
              {composioConnectionLabel(connection.status)}
            </p>
          </div>
          <Button
            aria-label={`Disconnect ${connection.alias ?? connection.toolkitSlug}`}
            disabled={pendingId !== null}
            size="sm"
            variant="ghost"
            onClick={() => onDisconnect(connection)}
          >
            Disconnect
          </Button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Composio key, accounts, and toolkit search for the Plugins directory. The user
 * brings a Composio API key; Composio runs each app's sign-in, so Akeru holds no
 * vendor OAuth credentials.
 */
export function ComposioSection({
  environmentId,
  query,
  catalog,
}: {
  readonly environmentId: EnvironmentId;
  readonly query: string;
  readonly catalog: readonly PluginDirectoryDefinition[];
}) {
  const status = useEnvironmentQuery(
    serverEnvironment.composioStatus({ environmentId, input: {} }),
  );
  const configure = useAtomCommand(serverEnvironment.configureComposio, { reportFailure: false });
  const remove = useAtomCommand(serverEnvironment.removeComposio, { reportFailure: false });
  const authorize = useAtomCommand(serverEnvironment.authorizeComposio, { reportFailure: false });
  const disconnect = useAtomCommand(serverEnvironment.disconnectComposio, {
    reportFailure: false,
  });
  const [apiKey, setApiKey] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const configured = status.data?.configured === true;
  const connections = status.data?.connections ?? [];
  const deferredQuery = useDeferredValue(query.trim());
  const searching = configured && deferredQuery.length >= COMPOSIO_MIN_SEARCH_LENGTH;
  const toolkits = useEnvironmentQuery(
    searching
      ? serverEnvironment.composioToolkits({
          environmentId,
          input: { query: deferredQuery, limit: 12 },
        })
      : null,
  );

  // Composio's sign-in finishes in another tab or the system browser, so pick up
  // the new account when this window regains focus.
  useEffect(() => {
    const refresh = status.refresh;
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [status.refresh]);

  const reportFailure = (
    title: string,
    result: Awaited<ReturnType<typeof configure>> | Awaited<ReturnType<typeof authorize>>,
  ): boolean => {
    if (result._tag !== "Failure") return false;
    if (isAtomCommandInterrupted(result)) return true;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "The command failed.",
    });
    return true;
  };

  const saveKey = async () => {
    const trimmed = apiKey.trim();
    if (!trimmed) return;
    setPendingId("key");
    const result = await configure({ environmentId, input: { apiKey: trimmed } });
    setPendingId(null);
    if (reportFailure("Could not save the Composio key", result)) return;
    setApiKey("");
    status.refresh();
  };

  const removeKey = async () => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      "Remove the Composio API key from this environment? Bots lose access to Composio apps until you add a key again.",
      { variant: "destructive" },
    );
    if (!confirmed) return;
    setPendingId("key");
    const result = await remove({ environmentId, input: {} });
    setPendingId(null);
    if (!reportFailure("Could not remove the Composio key", result)) status.refresh();
  };

  const connectToolkit = async (toolkit: ComposioToolkit) => {
    setPendingId(`toolkit:${toolkit.slug}`);
    const result = await authorize({ environmentId, input: { toolkitSlug: toolkit.slug } });
    setPendingId(null);
    if (result._tag === "Failure") {
      reportFailure(`Could not connect ${toolkit.name}`, result);
      return;
    }
    const url = new URL(result.value.redirectUrl);
    if (url.protocol !== "https:") {
      toastManager.add({
        type: "error",
        title: `Could not connect ${toolkit.name}`,
        description: "Composio returned a sign-in link that does not use HTTPS.",
      });
      return;
    }
    status.refresh();
    void ensureLocalApi()
      .shell.openExternal(url.toString())
      .catch(() =>
        toastManager.add({ type: "error", title: `Could not open ${toolkit.name} sign-in` }),
      );
  };

  const disconnectAccount = async (connection: ComposioConnection) => {
    const name = connection.alias ?? connection.toolkitSlug;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Disconnect ${name}? Bots stop using this account.`,
      { variant: "destructive" },
    );
    if (!confirmed) return;
    setPendingId(connection.id);
    const result = await disconnect({ environmentId, input: { connectionId: connection.id } });
    setPendingId(null);
    if (!reportFailure(`Could not disconnect ${name}`, result)) status.refresh();
  };

  const openKeysPage = () => {
    void ensureLocalApi()
      .shell.openExternal(COMPOSIO_API_KEYS_URL)
      .catch(() => toastManager.add({ type: "error", title: "Could not open Composio" }));
  };

  const results = composioSearchResults(toolkits.data ?? [], catalog);

  return (
    <>
      <section
        aria-label="Composio"
        className="flex flex-col gap-4 rounded-2xl border border-border/70 bg-card px-5 py-5"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-xl">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold">Composio</h2>
              {status.data ? (
                <Badge variant={configured ? "success" : "secondary"}>
                  {configured ? "Key saved" : "No key"}
                </Badge>
              ) : null}
            </div>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              {configured
                ? "Search above to find Composio apps. Composio handles each app's sign-in, and your bots can use connected accounts."
                : "Add your own Composio API key to connect apps such as Slack or Notion. Composio handles each app's sign-in."}
            </p>
          </div>
          <Button size="sm" variant="link" onClick={openKeysPage}>
            Get a Composio API key
          </Button>
        </div>
        {status.error ? (
          <p className="text-[13px] text-destructive-foreground">
            Could not reach Composio: {status.error}
          </p>
        ) : null}
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void saveKey();
          }}
        >
          <Input
            aria-label="Composio API key"
            autoComplete="off"
            className="min-w-0 flex-1 sm:max-w-sm"
            placeholder={configured ? "Paste a new key to replace it" : "Composio API key"}
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.currentTarget.value)}
          />
          <Button disabled={!apiKey.trim() || pendingId !== null} size="sm" type="submit">
            {configured ? "Replace key" : "Save key"}
          </Button>
          {configured ? (
            <Button
              disabled={pendingId !== null}
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => void removeKey()}
            >
              Remove key
            </Button>
          ) : null}
        </form>
        <p className="text-xs text-muted-foreground">
          The key is stored only on this Akeru Bot server.
        </p>
        {configured ? (
          <ComposioAccounts
            connections={connections}
            pendingId={pendingId}
            onDisconnect={(connection) => void disconnectAccount(connection)}
          />
        ) : null}
      </section>
      {searching && toolkits.error ? (
        <p className="px-1 text-[13px] text-destructive-foreground">
          Could not search Composio: {toolkits.error}
        </p>
      ) : null}
      {searching ? (
        <ComposioToolkitResults
          toolkits={results}
          connectedToolkitIds={activeComposioToolkitIds(connections)}
          pendingToolkitId={
            pendingId?.startsWith("toolkit:") ? pendingId.slice("toolkit:".length) : null
          }
          onConnect={(toolkit) => void connectToolkit(toolkit)}
        />
      ) : null}
    </>
  );
}
