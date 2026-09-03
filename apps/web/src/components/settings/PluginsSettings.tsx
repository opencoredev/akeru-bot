import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { McpServerId, type EnvironmentId, type McpServer } from "@t3tools/contracts";
import { ExternalLinkIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { randomUUID } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { environmentMcpServersAtom, mcpServerEnvironment } from "../../state/mcpServers";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsEnvironmentId } from "../../settingsDialogStore";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Field, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

interface McpServerDraft {
  readonly name: string;
  readonly transport: "stdio" | "url";
  readonly command: string;
  readonly args: string;
  readonly url: string;
}

const EMPTY_DRAFT: McpServerDraft = {
  name: "",
  transport: "stdio",
  command: "",
  args: "",
  url: "",
};

function draftFromServer(server: McpServer): McpServerDraft {
  return server.transport === "stdio"
    ? {
        name: server.name,
        transport: server.transport,
        command: server.command,
        args: server.args?.join("\n") ?? "",
        url: "",
      }
    : {
        name: server.name,
        transport: server.transport,
        command: "",
        args: "",
        url: server.url,
      };
}

export function validateMcpServerDraft(draft: McpServerDraft): string | null {
  if (draft.name.trim().length === 0) return "Name is required.";
  if (draft.transport === "stdio") {
    return draft.command.trim().length === 0 ? "Command is required." : null;
  }
  try {
    const url = new URL(draft.url.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "URL must start with http:// or https://.";
    }
    return url.username.length === 0 && url.password.length === 0
      ? null
      : "Store credentials outside the server URL.";
  } catch {
    return "Enter a valid HTTP or HTTPS URL.";
  }
}

function commandDescription(server: McpServer): string {
  if (server.transport === "url") return server.url;
  return [server.command, ...(server.args ?? [])].join(" ");
}

function PluginsSettingsForEnvironment({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const servers = useAtomValue(environmentMcpServersAtom(environmentId));
  const createServer = useAtomCommand(mcpServerEnvironment.create, { reportFailure: false });
  const updateServer = useAtomCommand(mcpServerEnvironment.update, { reportFailure: false });
  const deleteServer = useAtomCommand(mcpServerEnvironment.delete, { reportFailure: false });
  const enableServer = useAtomCommand(mcpServerEnvironment.enable, { reportFailure: false });
  const disableServer = useAtomCommand(mcpServerEnvironment.disable, { reportFailure: false });
  const composioStatus = useEnvironmentQuery(
    serverEnvironment.composioStatus({ environmentId, input: {} }),
  );
  const configureComposio = useAtomCommand(serverEnvironment.configureComposio, {
    reportFailure: false,
  });
  const removeComposio = useAtomCommand(serverEnvironment.removeComposio, {
    reportFailure: false,
  });
  const disconnectComposio = useAtomCommand(serverEnvironment.disconnectComposio, {
    reportFailure: false,
  });
  const [composioApiKey, setComposioApiKey] = useState("");
  const [composioPending, setComposioPending] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServer | null>(null);
  const [draft, setDraft] = useState<McpServerDraft>(EMPTY_DRAFT);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [pendingServerId, setPendingServerId] = useState<string | null>(null);
  const validationError = validateMcpServerDraft(draft);

  const reportComposioFailure = (
    title: string,
    result: Awaited<ReturnType<typeof configureComposio>>,
  ): boolean => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return false;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "The command failed.",
    });
    return true;
  };

  const saveComposio = async () => {
    const apiKey = composioApiKey.trim();
    if (!apiKey) return;
    setComposioPending("key");
    const result = await configureComposio({ environmentId, input: { apiKey } });
    setComposioPending(null);
    if (!reportComposioFailure("Could not connect Composio", result)) {
      setComposioApiKey("");
      composioStatus.refresh();
    }
  };

  const removeComposioKey = async () => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      "Remove the Composio API key from this environment?",
      { variant: "destructive" },
    );
    if (!confirmed) return;
    setComposioPending("key");
    const result = await removeComposio({ environmentId, input: {} });
    setComposioPending(null);
    if (!reportComposioFailure("Could not remove Composio", result)) composioStatus.refresh();
  };

  const disconnectComposioAccount = async (connectionId: string) => {
    setComposioPending(connectionId);
    const result = await disconnectComposio({ environmentId, input: { connectionId } });
    setComposioPending(null);
    if (!reportComposioFailure("Could not disconnect account", result)) composioStatus.refresh();
  };

  const openCreate = () => {
    setEditingServer(null);
    setDraft(EMPTY_DRAFT);
    setSubmitAttempted(false);
    setDialogOpen(true);
  };

  const openEdit = (server: McpServer) => {
    setEditingServer(server);
    setDraft(draftFromServer(server));
    setSubmitAttempted(false);
    setDialogOpen(true);
  };

  const reportFailure = (title: string, result: Awaited<ReturnType<typeof createServer>>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return false;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "The command failed.",
    });
    return true;
  };

  const save = async () => {
    setSubmitAttempted(true);
    if (validationError !== null) return;

    const mcpServerId = editingServer?.id ?? McpServerId.make(randomUUID());
    setPendingServerId(mcpServerId);
    const configuration =
      draft.transport === "stdio"
        ? {
            name: draft.name.trim(),
            transport: draft.transport,
            command: draft.command.trim(),
            args: draft.args
              .split("\n")
              .map((argument) => argument.trim())
              .filter((argument) => argument.length > 0),
          }
        : {
            name: draft.name.trim(),
            transport: draft.transport,
            url: draft.url.trim(),
          };
    const result = editingServer
      ? await updateServer({ environmentId, input: { mcpServerId, ...configuration } })
      : await createServer({ environmentId, input: { mcpServerId, ...configuration } });
    setPendingServerId(null);
    if (
      reportFailure(
        editingServer ? "Could not update MCP server" : "Could not add MCP server",
        result,
      )
    ) {
      return;
    }
    setDialogOpen(false);
  };

  const toggle = async (server: McpServer, enabled: boolean) => {
    setPendingServerId(server.id);
    const mutation = enabled ? enableServer : disableServer;
    const result = await mutation({
      environmentId,
      input: { mcpServerId: server.id },
    });
    setPendingServerId(null);
    reportFailure(enabled ? "Could not enable MCP server" : "Could not disable MCP server", result);
  };

  const remove = async (server: McpServer) => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Delete the MCP server '${server.name}'?`,
      { variant: "destructive" },
    );
    if (!confirmed) return;
    setPendingServerId(server.id);
    const result = await deleteServer({
      environmentId,
      input: { mcpServerId: server.id },
    });
    setPendingServerId(null);
    reportFailure("Could not delete MCP server", result);
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Composio"
        headerAction={
          <Badge variant={composioStatus.data?.configured ? "success" : "secondary"}>
            {composioStatus.data?.configured ? "Connected" : "Not connected"}
          </Badge>
        }
      >
        <SettingsRow title="API key" description="Stored only on this Akeru Bot server.">
          <form
            className="flex items-center gap-2 pt-3"
            onSubmit={(event) => {
              event.preventDefault();
              void saveComposio();
            }}
          >
            <Input
              aria-label="Composio API key"
              autoComplete="off"
              placeholder={
                composioStatus.data?.configured ? "Enter a new key to replace" : "Composio API key"
              }
              spellCheck={false}
              type="password"
              value={composioApiKey}
              onChange={(event) => setComposioApiKey(event.currentTarget.value)}
            />
            <Button
              disabled={!composioApiKey.trim() || composioPending !== null}
              size="sm"
              type="submit"
            >
              {composioStatus.data?.configured ? "Replace" : "Save"}
            </Button>
            {composioStatus.data?.configured ? (
              <Button
                disabled={composioPending !== null}
                size="sm"
                type="button"
                variant="outline"
                onClick={() => void removeComposioKey()}
              >
                Remove
              </Button>
            ) : null}
          </form>
          <Button
            className="mt-2 px-0"
            size="sm"
            type="button"
            variant="link"
            onClick={() =>
              void ensureLocalApi().shell.openExternal("https://app.composio.dev/settings/api-keys")
            }
          >
            Create a Composio API key
            <ExternalLinkIcon className="size-3.5" />
          </Button>
        </SettingsRow>
        {(composioStatus.data?.connections ?? []).length === 0 ? (
          <SettingsRow
            title="Connected accounts"
            description="Connect Gmail or another app from Plugins."
            status="No accounts"
          />
        ) : null}
        {(composioStatus.data?.connections ?? []).map((connection) => (
          <SettingsRow
            key={connection.id}
            title={connection.alias ?? connection.toolkitSlug}
            description={`${connection.toolkitSlug === "gmail" ? "Gmail" : connection.toolkitSlug} account`}
            status={connection.status}
            control={
              <Button
                aria-label={`Disconnect ${connection.alias ?? connection.toolkitSlug}`}
                disabled={composioPending !== null}
                size="sm"
                variant="outline"
                onClick={() => void disconnectComposioAccount(connection.id)}
              >
                Disconnect
              </Button>
            }
          />
        ))}
      </SettingsSection>

      <SettingsSection
        title="MCP servers"
        headerAction={
          <Button size="sm" onClick={openCreate}>
            <PlusIcon className="size-4" />
            Add server
          </Button>
        }
      >
        {servers.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            No MCP servers yet. A raw MCP server runs with or without Executor.
          </p>
        ) : (
          servers.map((server) => {
            const pending = pendingServerId === server.id;
            return (
              <SettingsRow
                key={server.id}
                title={server.name}
                description={commandDescription(server)}
                status={server.transport === "stdio" ? "Standard input/output" : "URL"}
                control={
                  <div className="flex items-center gap-1">
                    <Switch
                      checked={server.enabled}
                      disabled={pending}
                      onCheckedChange={(checked) => void toggle(server, Boolean(checked))}
                      aria-label={`${server.enabled ? "Disable" : "Enable"} ${server.name}`}
                    />
                    <Button
                      size="icon-sm"
                      variant="ghost-muted"
                      disabled={pending}
                      aria-label={`Edit ${server.name}`}
                      onClick={() => openEdit(server)}
                    >
                      <PencilIcon className="size-4" />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost-muted"
                      disabled={pending}
                      aria-label={`Delete ${server.name}`}
                      onClick={() => void remove(server)}
                    >
                      <Trash2Icon className="size-4" />
                    </Button>
                  </div>
                }
              />
            );
          })
        )}
      </SettingsSection>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingServer ? "Edit MCP server" : "Add MCP server"}</DialogTitle>
            <DialogDescription>
              Register a raw MCP server. Store credentials outside this record.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 px-6 py-4">
            <Field>
              <FieldLabel>Name</FieldLabel>
              <Input
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel>Transport</FieldLabel>
              <Select
                value={draft.transport}
                onValueChange={(transport) => {
                  if (transport === "stdio" || transport === "url") {
                    setDraft({ ...draft, transport });
                  }
                }}
              >
                <SelectTrigger className="w-full" aria-label="MCP transport">
                  <SelectValue>
                    {draft.transport === "stdio" ? "Standard input/output" : "URL"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="stdio">Standard input/output</SelectItem>
                  <SelectItem value="url">URL</SelectItem>
                </SelectPopup>
              </Select>
            </Field>
            {draft.transport === "stdio" ? (
              <>
                <Field>
                  <FieldLabel>Command</FieldLabel>
                  <Input
                    value={draft.command}
                    onChange={(event) => setDraft({ ...draft, command: event.currentTarget.value })}
                    placeholder="bunx"
                  />
                </Field>
                <Field>
                  <FieldLabel>Arguments, one per line</FieldLabel>
                  <Textarea
                    value={draft.args}
                    onChange={(event) => setDraft({ ...draft, args: event.currentTarget.value })}
                    placeholder={"@modelcontextprotocol/server-filesystem\n/workspace"}
                    rows={4}
                  />
                </Field>
              </>
            ) : (
              <Field>
                <FieldLabel>URL</FieldLabel>
                <Input
                  value={draft.url}
                  onChange={(event) => setDraft({ ...draft, url: event.currentTarget.value })}
                  placeholder="https://mcp.example.com"
                />
              </Field>
            )}
            {submitAttempted && validationError ? (
              <p className="text-xs text-destructive-foreground">{validationError}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button disabled={pendingServerId !== null} onClick={() => void save()}>
              {editingServer ? "Save" : "Add server"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SettingsPageContainer>
  );
}

export function PluginsSettingsPanel() {
  const environmentId = useSettingsEnvironmentId();
  if (environmentId === null) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="MCP servers">
          <p className="px-4 py-6 text-sm text-muted-foreground">
            Connect an environment to manage MCP servers.
          </p>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  return <PluginsSettingsForEnvironment environmentId={environmentId} />;
}
