import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  McpServerId,
  type ComposioToolkit,
  type EnvironmentId,
  type McpServer,
  type ProviderAccessStatus,
} from "@t3tools/contracts";
import { SearchIcon } from "lucide-react";
import { useDeferredValue, useEffect, useState } from "react";
import {
  isInstallablePlugin,
  loadDirectoryCatalog,
  type PluginDirectoryDefinition,
  type PluginSkill,
} from "../../../../../plugins";
import { ensureLocalApi } from "../../localApi";
import { cn, randomUUID } from "../../lib/utils";
import { closePlugins, usePluginsDialogStore } from "../../pluginsDialogStore";
import { environmentBotsAtom } from "../../state/bots";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { environmentMcpServersAtom, mcpServerEnvironment } from "../../state/mcpServers";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Field, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  CustomMcpServers,
  ComposioToolkitResults,
  PluginLogoImage,
  PluginsCatalog,
  RemovedBuiltinServers,
} from "./PluginsCatalog";
import { PluginDetails } from "./PluginDetails";
import { runPluginEnablePlan } from "./pluginConnection";
import {
  findPluginServer,
  isBuiltinMcpServer,
  planPluginToggle,
  pluginMcpServerId,
} from "./pluginRegistry";
import {
  buildPluginFilters,
  buildPluginSections,
  pluginActiveDependentBotNames,
  type PluginFilter,
} from "./pluginPresentation";

const CATALOG = loadDirectoryCatalog();
const gmailPlugin = CATALOG.find((plugin) => plugin.id === "gmail");
if (!gmailPlugin) throw new TypeError("Gmail is missing from the plugin directory.");
export const COMPOSIO_APPS = [gmailPlugin] as const;
export const PLUGIN_DIRECTORY_FILTERS = buildPluginFilters(CATALOG);

export function resolvePluginDialogServers(
  servers: readonly McpServer[],
  catalog: readonly PluginDirectoryDefinition[] = CATALOG,
): {
  readonly installedPlugins: readonly PluginDirectoryDefinition[];
  readonly customServers: readonly McpServer[];
  readonly removedBuiltinServers: readonly McpServer[];
} {
  const catalogServerIds = new Set(catalog.map(pluginMcpServerId));
  return {
    installedPlugins: catalog.filter((plugin) => findPluginServer(plugin, servers)),
    customServers: servers.filter((server) => !isBuiltinMcpServer(server)),
    removedBuiltinServers: servers.filter(
      (server) => isBuiltinMcpServer(server) && !catalogServerIds.has(server.id),
    ),
  };
}

export const PLUGIN_DIALOG_CLASS_NAME = "h-[min(48rem,90dvh)] max-w-5xl flex-col overflow-hidden";
export const PLUGIN_DIRECTORY_HEADER_CLASS_NAME = "shrink-0 gap-3 px-6 pt-5 pb-4";
export const PLUGIN_DIRECTORY_PANEL_CLASS_NAME = "space-y-8 px-5 pt-5! pb-5 sm:px-6";

export function pluginRecoveryNotice(pluginTitle: string, recoveryFailures: readonly string[]) {
  if (recoveryFailures.length === 0) return null;
  return {
    type: "warning" as const,
    title: `${pluginTitle} connected with a session issue`,
    description: `${recoveryFailures.join(" ")} Restart the affected agent session to retry.`,
  };
}

export interface McpServerDraft {
  readonly name: string;
  readonly transport: "stdio" | "url";
  readonly command: string;
  readonly args: string;
  readonly url: string;
}

export const EMPTY_MCP_SERVER_DRAFT: McpServerDraft = {
  name: "",
  transport: "stdio",
  command: "",
  args: "",
  url: "",
};

type EditorTarget = { readonly server: McpServer | null };

function draftFromServer(server: McpServer): McpServerDraft {
  return server.transport === "stdio"
    ? {
        name: server.name,
        transport: "stdio",
        command: server.command,
        args: server.args?.join("\n") ?? "",
        url: "",
      }
    : {
        name: server.name,
        transport: "url",
        command: "",
        args: "",
        url: server.url,
      };
}

export function validateMcpServerDraft(draft: McpServerDraft): string | null {
  if (!draft.name.trim()) return "Name is required.";
  if (draft.transport === "stdio") {
    return draft.command.trim() ? null : "Command is required.";
  }
  try {
    const url = new URL(draft.url.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "URL must start with http:// or https://.";
    }
    return url.username || url.password ? "Store credentials outside the server URL." : null;
  } catch {
    return "Enter a valid HTTP or HTTPS URL.";
  }
}

function PluginsDialogForEnvironment({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const requestedQuery = usePluginsDialogStore((state) => state.requestedQuery);
  const servers = useAtomValue(environmentMcpServersAtom(environmentId));
  const bots = useAtomValue(environmentBotsAtom(environmentId));
  const subscriptionAuth = useEnvironmentQuery(
    serverEnvironment.subscriptionAuth({ environmentId, input: {} }),
  );
  const composioStatus = useEnvironmentQuery(
    serverEnvironment.composioStatus({ environmentId, input: {} }),
  );
  const configureComposio = useAtomCommand(serverEnvironment.configureComposio, {
    reportFailure: false,
  });
  const authorizeComposio = useAtomCommand(serverEnvironment.authorizeComposio, {
    reportFailure: false,
  });
  const disconnectComposio = useAtomCommand(serverEnvironment.disconnectComposio, {
    reportFailure: false,
  });
  const createServer = useAtomCommand(mcpServerEnvironment.create, { reportFailure: false });
  const updateServer = useAtomCommand(mcpServerEnvironment.update, { reportFailure: false });
  const deleteServer = useAtomCommand(mcpServerEnvironment.delete, { reportFailure: false });
  const enableServer = useAtomCommand(mcpServerEnvironment.enable, { reportFailure: false });
  const disableServer = useAtomCommand(mcpServerEnvironment.disable, { reportFailure: false });
  const authenticateServer = useAtomCommand(serverEnvironment.authenticateMcpServer, {
    reportFailure: false,
  });
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim());
  const [filter, setFilter] = useState<PluginFilter>("All");
  const [selectedPlugin, setSelectedPlugin] = useState<PluginDirectoryDefinition | null>(null);
  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null);
  const [draft, setDraft] = useState(EMPTY_MCP_SERVER_DRAFT);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [pendingServerId, setPendingServerId] = useState<string | null>(null);
  const [composioSetupPlugin, setComposioSetupPlugin] = useState<PluginDirectoryDefinition | null>(
    null,
  );
  const [composioApiKey, setComposioApiKey] = useState("");
  const composioToolkits = useEnvironmentQuery(
    composioStatus.data?.configured === true && deferredQuery.length >= 2
      ? serverEnvironment.composioToolkits({
          environmentId,
          input: { query: deferredQuery, limit: 12 },
        })
      : null,
  );
  const { customServers, installedPlugins, removedBuiltinServers } =
    resolvePluginDialogServers(servers);
  const connectedComposioPluginIds = new Set(
    (composioStatus.data?.connections ?? [])
      .filter((connection) => connection.status === "ACTIVE")
      .map((connection) => connection.toolkitSlug),
  );
  const composioViewServers: readonly McpServer[] = CATALOG.filter(
    (plugin) => plugin.connection.type === "brokered" && connectedComposioPluginIds.has(plugin.id),
  ).map((plugin) => ({
    id: pluginMcpServerId(plugin),
    name: plugin.title,
    transport: "url" as const,
    url: "https://composio.dev",
    enabled: true,
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  }));
  const displayServers = [...servers, ...composioViewServers];
  const brokeredCatalogIds = new Set(
    CATALOG.filter((plugin) => plugin.connection.type === "brokered").map((plugin) => plugin.id),
  );
  const composioSearchResults = (composioToolkits.data ?? []).filter(
    (toolkit) => !brokeredCatalogIds.has(toolkit.slug),
  );
  const sections = buildPluginSections({
    plugins: CATALOG,
    query,
    filter,
    installedPluginIds: new Set([
      ...installedPlugins.map((plugin) => plugin.id),
      ...connectedComposioPluginIds,
    ]),
  });
  const validationError = validateMcpServerDraft(draft);
  const selectedPluginServer = selectedPlugin
    ? findPluginServer(selectedPlugin, displayServers)
    : undefined;

  useEffect(() => {
    const refresh = () => composioStatus.refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [composioStatus.refresh]);
  useEffect(() => {
    if (requestedQuery !== null) setQuery(requestedQuery);
  }, [requestedQuery]);
  const selectedPluginAccess: ProviderAccessStatus | undefined = selectedPlugin
    ? subscriptionAuth.data?.access.find((status) => status.pluginId === selectedPlugin.id)
    : undefined;

  const reportFailure = (
    title: string,
    result: Awaited<ReturnType<typeof createServer>>,
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

  const openCustomEditor = (server: McpServer) => {
    setEditorTarget({ server });
    setDraft(draftFromServer(server));
    setSubmitAttempted(false);
  };

  const openCustomCreator = () => {
    setEditorTarget({ server: null });
    setDraft(EMPTY_MCP_SERVER_DRAFT);
    setSubmitAttempted(false);
  };

  const closeEditor = () => {
    setEditorTarget(null);
    setSubmitAttempted(false);
  };

  const togglePlugin = async (plugin: PluginDirectoryDefinition, enabled: boolean) => {
    if (plugin.connection.type === "brokered" && plugin.connection.broker.name === "Composio") {
      const mcpServerId = pluginMcpServerId(plugin);
      if (enabled && composioStatus.data?.configured !== true) {
        setComposioSetupPlugin(plugin);
        return;
      }
      setPendingServerId(mcpServerId);
      if (enabled) {
        const result = await authorizeComposio({
          environmentId,
          input: { toolkitSlug: plugin.id },
        });
        setPendingServerId(null);
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add({
              type: "error",
              title: `Could not connect ${plugin.title}`,
              description: error instanceof Error ? error.message : "The command failed.",
            });
          }
          return;
        }
        openExternal(result.value.redirectUrl, `Could not open ${plugin.title} sign-in`);
        return;
      }
      const connections = (composioStatus.data?.connections ?? []).filter(
        (connection) => connection.toolkitSlug === plugin.id,
      );
      const confirmed = await ensureLocalApi().dialogs.confirm(
        `Disconnect ${connections.length} ${plugin.title} account${connections.length === 1 ? "" : "s"}?`,
        { variant: "destructive" },
      );
      if (!confirmed) {
        setPendingServerId(null);
        return;
      }
      for (const connection of connections) {
        const result = await disconnectComposio({
          environmentId,
          input: { connectionId: connection.id },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: `Could not disconnect ${plugin.title}`,
            description: error instanceof Error ? error.message : "The command failed.",
          });
          break;
        }
      }
      setPendingServerId(null);
      composioStatus.refresh();
      return;
    }
    if (!enabled) {
      const mcpServerId = pluginMcpServerId(plugin);
      setPendingServerId(mcpServerId);
      const result = await disableServer({ environmentId, input: { mcpServerId } });
      setPendingServerId(null);
      reportFailure(`Could not disable ${plugin.title}`, result);
      return;
    }
    if (!isInstallablePlugin(plugin)) return;

    const plan = planPluginToggle(plugin, servers, true);
    if (plan.action === "disable") return;
    setPendingServerId(plan.mcpServerId);
    const commandSucceeded = (title: string, result: Awaited<ReturnType<typeof createServer>>) => {
      if (result._tag === "Success") return true;
      reportFailure(title, result);
      return false;
    };
    const shouldAuthenticate =
      plugin.authentication === "oauth" || plugin.authentication === "optional-oauth";

    try {
      await runPluginEnablePlan(plan, {
        create: async (mcpServerId, configuration) =>
          commandSucceeded(
            `Could not enable ${plugin.title}`,
            await createServer({
              environmentId,
              input: { mcpServerId, ...configuration },
            }),
          ),
        update: async (mcpServerId, configuration) =>
          commandSucceeded(
            `Could not update ${plugin.title}`,
            await updateServer({
              environmentId,
              input: { mcpServerId, ...configuration },
            }),
          ),
        enable: async (mcpServerId) =>
          commandSucceeded(
            `Could not enable ${plugin.title}`,
            await enableServer({ environmentId, input: { mcpServerId } }),
          ),
        ...(shouldAuthenticate
          ? {
              authenticate: async (mcpServerId, onAuthorizationUrl) => {
                const result = await authenticateServer({
                  environmentId,
                  mcpServerId,
                  onAuthorizationUrl,
                });
                if (result._tag === "Success") {
                  const notice = pluginRecoveryNotice(plugin.title, result.value.recoveryFailures);
                  if (notice) toastManager.add(notice);
                  return true;
                }
                if (!isAtomCommandInterrupted(result)) {
                  const error = squashAtomCommandFailure(result);
                  toastManager.add({
                    type: "error",
                    title: `Could not connect ${plugin.title}`,
                    description: error instanceof Error ? error.message : "Authentication failed.",
                  });
                }
                return false;
              },
            }
          : {}),
        openAuthorizationUrl: async (url) => {
          const authorizationUrl = new URL(url);
          if (authorizationUrl.protocol !== "https:") {
            throw new Error("The authorization URL must use HTTPS.");
          }
          await ensureLocalApi().shell.openExternal(authorizationUrl.toString());
        },
      });
    } finally {
      setPendingServerId(null);
      subscriptionAuth.refresh();
    }
  };

  const connectComposioToolkit = async (toolkit: ComposioToolkit) => {
    setPendingServerId(`composio:${toolkit.slug}`);
    const result = await authorizeComposio({
      environmentId,
      input: { toolkitSlug: toolkit.slug },
    });
    setPendingServerId(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: `Could not connect ${toolkit.name}`,
          description: error instanceof Error ? error.message : "The command failed.",
        });
      }
      return;
    }
    openExternal(result.value.redirectUrl, `Could not open ${toolkit.name} sign-in`);
  };

  const saveComposioAndConnect = async () => {
    const plugin = composioSetupPlugin;
    const apiKey = composioApiKey.trim();
    if (!plugin || !apiKey) return;
    setPendingServerId(pluginMcpServerId(plugin));
    const configured = await configureComposio({ environmentId, input: { apiKey } });
    if (configured._tag === "Failure") {
      setPendingServerId(null);
      if (!isAtomCommandInterrupted(configured)) {
        const error = squashAtomCommandFailure(configured);
        toastManager.add({
          type: "error",
          title: "Could not connect Composio",
          description: error instanceof Error ? error.message : "The command failed.",
        });
      }
      return;
    }
    const authorized = await authorizeComposio({
      environmentId,
      input: { toolkitSlug: plugin.id },
    });
    setPendingServerId(null);
    if (authorized._tag === "Failure") {
      if (!isAtomCommandInterrupted(authorized)) {
        const error = squashAtomCommandFailure(authorized);
        toastManager.add({
          type: "error",
          title: `Could not connect ${plugin.title}`,
          description: error instanceof Error ? error.message : "The command failed.",
        });
      }
      return;
    }
    setComposioApiKey("");
    setComposioSetupPlugin(null);
    composioStatus.refresh();
    openExternal(authorized.value.redirectUrl, `Could not open ${plugin.title} sign-in`);
  };

  const toggleCustom = async (server: McpServer, enabled: boolean) => {
    setPendingServerId(server.id);
    const result = await (enabled ? enableServer : disableServer)({
      environmentId,
      input: { mcpServerId: server.id },
    });
    setPendingServerId(null);
    reportFailure(enabled ? "Could not enable MCP server" : "Could not disable MCP server", result);
  };

  const saveEditor = async () => {
    setSubmitAttempted(true);
    if (!editorTarget || validationError) return;
    const mcpServerId = editorTarget.server?.id ?? McpServerId.make(randomUUID());
    const configuration =
      draft.transport === "stdio"
        ? {
            name: draft.name.trim(),
            transport: "stdio" as const,
            command: draft.command.trim(),
            args: draft.args
              .split("\n")
              .map((argument) => argument.trim())
              .filter(Boolean),
          }
        : { name: draft.name.trim(), transport: "url" as const, url: draft.url.trim() };
    setPendingServerId(mcpServerId);
    const result = editorTarget.server
      ? await updateServer({ environmentId, input: { mcpServerId, ...configuration } })
      : await createServer({ environmentId, input: { mcpServerId, ...configuration } });
    setPendingServerId(null);
    if (
      !reportFailure(
        editorTarget.server ? "Could not update MCP server" : "Could not add MCP server",
        result,
      )
    ) {
      closeEditor();
    }
  };

  const openPlugin = (plugin: PluginDirectoryDefinition) => {
    setSelectedPlugin(plugin);
  };

  const openExternal = (url: string, failureTitle: string) => {
    void ensureLocalApi()
      .shell.openExternal(url)
      .catch(() => toastManager.add({ type: "error", title: failureTitle }));
  };

  const openPluginSkill = (skill: PluginSkill) => {
    openExternal(skill.url, "Could not open skill");
  };

  const removeServer = async (server: McpServer) => {
    const confirmed = await ensureLocalApi().dialogs.confirm(`Remove '${server.name}'?`, {
      variant: "destructive",
    });
    if (!confirmed) return;
    setPendingServerId(server.id);
    const result = await deleteServer({ environmentId, input: { mcpServerId: server.id } });
    setPendingServerId(null);
    reportFailure("Could not remove MCP server", result);
  };

  return (
    <>
      {selectedPlugin ? (
        <PluginDetails
          plugin={selectedPlugin}
          server={selectedPluginServer}
          {...(selectedPluginAccess ? { accessStatus: selectedPluginAccess } : {})}
          activeDependentBotNames={pluginActiveDependentBotNames(selectedPluginServer, bots)}
          pending={pendingServerId === pluginMcpServerId(selectedPlugin)}
          onBack={() => setSelectedPlugin(null)}
          onToggle={(enabled) => void togglePlugin(selectedPlugin, enabled)}
          onRemove={() => {
            if (selectedPlugin.connection.type === "brokered") {
              void togglePlugin(selectedPlugin, false);
              return;
            }
            const server = findPluginServer(selectedPlugin, servers);
            if (server) void removeServer(server);
          }}
          onViewDocumentation={() =>
            openExternal(selectedPlugin.documentationUrl, "Could not open documentation")
          }
          onViewSource={() => openExternal(selectedPlugin.sourceUrl, "Could not open source")}
          onOpenSkill={openPluginSkill}
        />
      ) : (
        <>
          <DialogHeader className={PLUGIN_DIRECTORY_HEADER_CLASS_NAME}>
            <div className="pe-8">
              <DialogTitle>Plugins</DialogTitle>
            </div>
            <div className="relative">
              <SearchIcon
                aria-hidden="true"
                className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                aria-label="Search plugins"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Search plugins"
                className="h-9 ps-9"
              />
            </div>
            <div
              className="flex gap-1.5 overflow-x-auto pb-1"
              aria-label="Plugin sections and categories"
            >
              {PLUGIN_DIRECTORY_FILTERS.map((item) => (
                <button
                  aria-pressed={filter === item}
                  className={cn(
                    "shrink-0 cursor-pointer rounded-full border px-2.5 py-1 text-xs outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    filter === item
                      ? "border-transparent bg-accent text-accent-foreground"
                      : "border-border/70 text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                  key={item}
                  type="button"
                  onClick={() => setFilter(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </DialogHeader>
          <DialogPanel className={PLUGIN_DIRECTORY_PANEL_CLASS_NAME}>
            <PluginsCatalog
              sections={sections}
              servers={displayServers}
              accessStatuses={subscriptionAuth.data?.access ?? []}
              pendingServerId={pendingServerId}
              onToggle={(plugin, enabled) => void togglePlugin(plugin, enabled)}
              onOpen={openPlugin}
            />
            <ComposioToolkitResults
              toolkits={composioSearchResults}
              connectedToolkitIds={connectedComposioPluginIds}
              pendingToolkitId={
                pendingServerId?.startsWith("composio:")
                  ? pendingServerId.slice("composio:".length)
                  : null
              }
              onConnect={(toolkit) => void connectComposioToolkit(toolkit)}
            />
            {filter === "Installed" ? (
              <>
                <RemovedBuiltinServers
                  servers={removedBuiltinServers}
                  pendingServerId={pendingServerId}
                  onDelete={(server) => void removeServer(server)}
                />
                <CustomMcpServers
                  servers={customServers}
                  pendingServerId={pendingServerId}
                  onCreate={openCustomCreator}
                  onToggle={(server, enabled) => void toggleCustom(server, enabled)}
                  onEdit={openCustomEditor}
                  onDelete={(server) => void removeServer(server)}
                />
              </>
            ) : null}
          </DialogPanel>
        </>
      )}
      <Dialog open={editorTarget !== null} onOpenChange={(open) => !open && closeEditor()}>
        <DialogPopup className="max-h-[min(36rem,90dvh)] max-w-lg flex-col overflow-hidden">
          <DialogHeader className="shrink-0 border-b px-6 py-5">
            <DialogTitle>{editorTarget?.server ? "Edit MCP server" : "Add MCP server"}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-4 px-6 py-5">
            <Field>
              <FieldLabel>Name</FieldLabel>
              <Input
                autoFocus
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
              />
            </Field>
            <Field>
              <FieldLabel>Transport</FieldLabel>
              <Select
                value={draft.transport}
                onValueChange={(transport) => {
                  if (transport === "stdio" || transport === "url")
                    setDraft({ ...draft, transport });
                }}
              >
                <SelectTrigger className="w-full" aria-label="MCP transport">
                  <SelectValue>
                    {draft.transport === "stdio" ? "Local command" : "Remote URL"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="stdio">Local command</SelectItem>
                  <SelectItem value="url">Remote URL</SelectItem>
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
                    rows={4}
                    value={draft.args}
                    onChange={(event) => setDraft({ ...draft, args: event.currentTarget.value })}
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
          </DialogPanel>
          <DialogFooter className="shrink-0">
            <Button variant="ghost" onClick={closeEditor}>
              Cancel
            </Button>
            <Button disabled={pendingServerId !== null} onClick={() => void saveEditor()}>
              {editorTarget?.server ? "Save" : "Add server"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={composioSetupPlugin !== null}
        onOpenChange={(open) => {
          if (!open) setComposioSetupPlugin(null);
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader className="pb-4">
            <div className="flex items-center gap-3 pe-8">
              {composioSetupPlugin ? (
                <PluginLogoImage className="size-11 rounded-xl" plugin={composioSetupPlugin} />
              ) : null}
              <div className="min-w-0">
                <DialogTitle>Connect {composioSetupPlugin?.title}</DialogTitle>
                <DialogDescription>Sign-in handled by Composio</DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className="space-y-4 border-t px-6 py-5">
            <Field>
              <FieldLabel>Composio API key</FieldLabel>
              <Input
                autoFocus
                autoComplete="off"
                type="password"
                value={composioApiKey}
                onChange={(event) => setComposioApiKey(event.currentTarget.value)}
              />
              <p className="text-xs leading-5 text-muted-foreground">
                Stored only on this Akeru Bot server.
              </p>
            </Field>
            <Button
              className="px-0"
              size="sm"
              variant="link"
              onClick={() =>
                openExternal(
                  "https://app.composio.dev/settings/api-keys",
                  "Could not open Composio",
                )
              }
            >
              Create a Composio API key
            </Button>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setComposioSetupPlugin(null)}>
              Cancel
            </Button>
            <Button
              disabled={!composioApiKey.trim() || pendingServerId !== null}
              onClick={() => void saveComposioAndConnect()}
            >
              Connect
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

export function PluginsDialog() {
  const open = usePluginsDialogStore((state) => state.open);
  const environmentId = usePrimaryEnvironmentId();
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && closePlugins()}>
      <DialogPopup bottomStickOnMobile={false} className={PLUGIN_DIALOG_CLASS_NAME}>
        {environmentId ? (
          <PluginsDialogForEnvironment environmentId={environmentId} />
        ) : (
          <DialogHeader>
            <DialogTitle>Plugins</DialogTitle>
            <DialogDescription>Connect an environment to manage plugins.</DialogDescription>
          </DialogHeader>
        )}
      </DialogPopup>
    </Dialog>
  );
}
