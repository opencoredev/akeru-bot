import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, McpServer } from "@t3tools/contracts";
import { SearchIcon } from "lucide-react";
import { useState } from "react";
import {
  isInstallablePlugin,
  loadDirectoryCatalog,
  type PluginDirectoryDefinition,
  type PluginSkill,
} from "../../../../../plugins";
import { ensureLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { closePlugins, usePluginsDialogStore } from "../../pluginsDialogStore";
import { environmentBotsAtom } from "../../state/bots";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { environmentMcpServersAtom, mcpServerEnvironment } from "../../state/mcpServers";
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
import { CustomMcpServers, PluginsCatalog, RemovedBuiltinServers } from "./PluginsCatalog";
import { PluginDetails } from "./PluginDetails";
import {
  findPluginServer,
  isBuiltinMcpServer,
  planPluginToggle,
  pluginMcpServerId,
} from "./pluginRegistry";
import {
  buildPluginSections,
  pluginActiveDependentBotNames,
  PLUGIN_FILTERS,
  type PluginFilter,
} from "./pluginPresentation";

const CATALOG = loadDirectoryCatalog();

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
export const PLUGIN_DIRECTORY_HEADER_CLASS_NAME =
  "max-h-[45%] min-h-0 gap-3 overflow-y-auto overscroll-contain px-6 py-5";
export const PLUGIN_DIRECTORY_PANEL_CLASS_NAME = "space-y-8 px-5 pt-5! pb-5 sm:px-6";

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

type EditorTarget = { readonly server: McpServer };

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
  const servers = useAtomValue(environmentMcpServersAtom(environmentId));
  const bots = useAtomValue(environmentBotsAtom(environmentId));
  const createServer = useAtomCommand(mcpServerEnvironment.create, { reportFailure: false });
  const updateServer = useAtomCommand(mcpServerEnvironment.update, { reportFailure: false });
  const deleteServer = useAtomCommand(mcpServerEnvironment.delete, { reportFailure: false });
  const enableServer = useAtomCommand(mcpServerEnvironment.enable, { reportFailure: false });
  const disableServer = useAtomCommand(mcpServerEnvironment.disable, { reportFailure: false });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PluginFilter>("All");
  const [selectedPlugin, setSelectedPlugin] = useState<PluginDirectoryDefinition | null>(null);
  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null);
  const [draft, setDraft] = useState(EMPTY_MCP_SERVER_DRAFT);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [pendingServerId, setPendingServerId] = useState<string | null>(null);
  const { customServers, installedPlugins, removedBuiltinServers } =
    resolvePluginDialogServers(servers);
  const sections = buildPluginSections({
    plugins: CATALOG,
    query,
    filter,
    installedPluginIds: new Set(installedPlugins.map((plugin) => plugin.id)),
  });
  const validationError = validateMcpServerDraft(draft);
  const selectedPluginServer = selectedPlugin
    ? findPluginServer(selectedPlugin, servers)
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

  const closeEditor = () => {
    setEditorTarget(null);
    setSubmitAttempted(false);
  };

  const togglePlugin = async (plugin: PluginDirectoryDefinition, enabled: boolean) => {
    if (!isInstallablePlugin(plugin)) return;
    const plan = planPluginToggle(plugin, servers, enabled);
    setPendingServerId(plan.mcpServerId);
    if (plan.action === "refresh-and-enable") {
      const updateResult = await updateServer({
        environmentId,
        input: { mcpServerId: plan.mcpServerId, ...plan.configuration },
      });
      if (reportFailure(`Could not update ${plugin.title}`, updateResult)) {
        setPendingServerId(null);
        return;
      }
    }
    const result =
      plan.action === "create"
        ? await createServer({
            environmentId,
            input: { mcpServerId: plan.mcpServerId, ...plan.configuration },
          })
        : await (plan.action === "refresh-and-enable" ? enableServer : disableServer)({
            environmentId,
            input: { mcpServerId: plan.mcpServerId },
          });
    setPendingServerId(null);
    reportFailure(
      enabled ? `Could not enable ${plugin.title}` : `Could not disable ${plugin.title}`,
      result,
    );
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
    const mcpServerId = editorTarget.server.id;
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
    const result = await updateServer({
      environmentId,
      input: { mcpServerId, ...configuration },
    });
    setPendingServerId(null);
    if (!reportFailure("Could not update MCP server", result)) closeEditor();
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
          activeDependentBotNames={pluginActiveDependentBotNames(selectedPluginServer, bots)}
          pending={pendingServerId === pluginMcpServerId(selectedPlugin)}
          onBack={() => setSelectedPlugin(null)}
          onToggle={(enabled) => void togglePlugin(selectedPlugin, enabled)}
          onRemove={() => {
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
            <div className="flex flex-wrap gap-1.5" aria-label="Plugin sections and categories">
              {PLUGIN_FILTERS.map((item) => (
                <button
                  aria-pressed={filter === item}
                  className={cn(
                    "cursor-pointer rounded-md border px-2.5 py-1 text-xs outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring",
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
              servers={servers}
              pendingServerId={pendingServerId}
              onToggle={(plugin, enabled) => void togglePlugin(plugin, enabled)}
              onOpen={openPlugin}
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
            <DialogTitle>Edit MCP server</DialogTitle>
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
              Save
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
