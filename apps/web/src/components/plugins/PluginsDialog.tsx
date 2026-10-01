import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@akeru/client-runtime/state/runtime";
import {
  McpServerId,
  type EnvironmentId,
  type McpServer,
  type ProviderAccessStatus,
} from "@akeru/contracts";
import { useChangedSinceMount } from "../../hooks/useChangedSinceMount";
import { useEffect, useState } from "react";
import {
  integrationsShListing,
  isInstallablePlugin,
  type PluginDirectoryDefinition,
  type PluginSkill,
} from "../../../../../plugins";
import { createTranslator } from "@akeru/client-runtime/i18n";
import { useI18n } from "../../i18n";
import { ensureLocalApi } from "../../localApi";
import { randomUUID } from "../../lib/utils";
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
import { SidebarInset } from "../ui/sidebar";
import { ComposioSection } from "./ComposioSection";
import {
  draftFromServer,
  EMPTY_MCP_SERVER_DRAFT,
  validateMcpServerDraft,
} from "./mcpServerDraft.logic";
import {
  PLUGIN_PAGE_COLUMN_CLASS_NAME,
  PluginDirectoryLayout,
  PluginFilterBar,
  PluginSearchField,
  PluginsPageHeader,
} from "./PluginDirectoryLayout";
import { FULL_PLUGIN_CATALOG, LISTED_PLUGIN_CATALOG } from "./pluginDirectoryCatalog";
import { CustomMcpServers, PluginsCatalog, RemovedBuiltinServers } from "./PluginsCatalog";
import { PluginDetails } from "./PluginDetails";
import { runPluginEnablePlan } from "./pluginConnection";
import {
  findPluginServer,
  isBuiltinMcpServer,
  planPluginToggle,
  pluginMcpServerId,
} from "./pluginRegistry";
import {
  buildPluginSections,
  pluginActiveDependentBotNames,
  pluginBlocker,
  type PluginFilter,
} from "./pluginPresentation";

export {
  PLUGIN_DIRECTORY_HEADER_CLASS_NAME,
  PLUGIN_DIRECTORY_PANEL_CLASS_NAME,
  PLUGIN_PAGE_COLUMN_CLASS_NAME,
  PluginsPageHeader,
} from "./PluginDirectoryLayout";
export { PLUGIN_DIRECTORY_FILTERS } from "./pluginDirectoryCatalog";
export {
  EMPTY_MCP_SERVER_DRAFT,
  type McpServerDraft,
  validateMcpServerDraft,
} from "./mcpServerDraft.logic";

const englishTranslator = createTranslator("en");

type Translate = typeof englishTranslator.translate;

export function resolvePluginDialogServers(
  servers: readonly McpServer[],
  catalog: readonly PluginDirectoryDefinition[] = FULL_PLUGIN_CATALOG,
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

/** The named blocker for a brokered plugin that cannot connect yet, or null when it can. */
export function pluginBrokeredBlockerNotice(
  plugin: PluginDirectoryDefinition,
  t: Translate = englishTranslator.translate,
) {
  const blocker = pluginBlocker(plugin);
  if (plugin.connection.type !== "brokered" || blocker === null) return null;
  return {
    type: "warning" as const,
    title: t("{name} is not available yet", { name: plugin.title }),
    description: blocker,
  };
}

export function pluginRecoveryNotice(
  pluginTitle: string,
  recoveryFailures: readonly string[],
  t: Translate = englishTranslator.translate,
) {
  if (recoveryFailures.length === 0) return null;
  return {
    type: "warning" as const,
    title: t("{name} connected with a session issue", { name: pluginTitle }),
    description: t("{failures} Restart the affected bot session to retry.", {
      failures: recoveryFailures.join(" "),
    }),
  };
}

type EditorTarget = { readonly server: McpServer | null };

function PluginsDialogForEnvironment({
  environmentId,
  standalone = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly standalone?: boolean;
}) {
  const { t } = useI18n();
  const requestedQuery = usePluginsDialogStore((state) => state.requestedQuery);
  const servers = useAtomValue(environmentMcpServersAtom(environmentId));
  const bots = useAtomValue(environmentBotsAtom(environmentId));
  const subscriptionAuth = useEnvironmentQuery(
    serverEnvironment.subscriptionAuth({ environmentId, input: {} }),
  );
  const createServer = useAtomCommand(mcpServerEnvironment.create, { reportFailure: false });
  const updateServer = useAtomCommand(mcpServerEnvironment.update, { reportFailure: false });
  const deleteServer = useAtomCommand(mcpServerEnvironment.delete, { reportFailure: false });
  const enableServer = useAtomCommand(mcpServerEnvironment.enable, { reportFailure: false });
  const disableServer = useAtomCommand(mcpServerEnvironment.disable, { reportFailure: false });
  const authenticateServer = useAtomCommand(serverEnvironment.authenticateMcpServer, {
    reportFailure: false,
  });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PluginFilter>("All");
  const [selectedPlugin, setSelectedPlugin] = useState<PluginDirectoryDefinition | null>(null);
  const leftDirectory = useChangedSinceMount(selectedPlugin === null);
  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null);
  const [draft, setDraft] = useState(EMPTY_MCP_SERVER_DRAFT);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [pendingServerId, setPendingServerId] = useState<string | null>(null);
  const { customServers, installedPlugins, removedBuiltinServers } =
    resolvePluginDialogServers(servers);
  const sections = buildPluginSections({
    plugins: LISTED_PLUGIN_CATALOG,
    query,
    filter,
    installedPluginIds: new Set(installedPlugins.map((plugin) => plugin.id)),
  });
  const validationError = validateMcpServerDraft(draft, t);
  const selectedPluginServer = selectedPlugin
    ? findPluginServer(selectedPlugin, servers)
    : undefined;

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
      description: error instanceof Error ? error.message : t("The command failed."),
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
    // The catalog already disables this toggle; a direct caller still gets
    // the named blocker instead of a dead click.
    if (enabled) {
      const notice = pluginBrokeredBlockerNotice(plugin, t);
      if (notice) {
        toastManager.add(notice);
        return;
      }
    }
    if (!enabled) {
      const mcpServerId = pluginMcpServerId(plugin);
      setPendingServerId(mcpServerId);
      const result = await disableServer({ environmentId, input: { mcpServerId } });
      setPendingServerId(null);
      reportFailure(t("Could not disable {name}", { name: plugin.title }), result);
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
            t("Could not enable {name}", { name: plugin.title }),
            await createServer({
              environmentId,
              input: { mcpServerId, ...configuration },
            }),
          ),
        update: async (mcpServerId, configuration) =>
          commandSucceeded(
            t("Could not update {name}", { name: plugin.title }),
            await updateServer({
              environmentId,
              input: { mcpServerId, ...configuration },
            }),
          ),
        enable: async (mcpServerId) =>
          commandSucceeded(
            t("Could not enable {name}", { name: plugin.title }),
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
                  const notice = pluginRecoveryNotice(
                    plugin.title,
                    result.value.recoveryFailures,
                    t,
                  );
                  if (notice) toastManager.add(notice);
                  return true;
                }
                if (!isAtomCommandInterrupted(result)) {
                  const error = squashAtomCommandFailure(result);
                  toastManager.add({
                    type: "error",
                    title: t("Could not connect {name}", { name: plugin.title }),
                    description:
                      error instanceof Error ? error.message : t("Authentication failed."),
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

  const toggleCustom = async (server: McpServer, enabled: boolean) => {
    setPendingServerId(server.id);
    const result = await (enabled ? enableServer : disableServer)({
      environmentId,
      input: { mcpServerId: server.id },
    });
    setPendingServerId(null);
    reportFailure(
      enabled ? t("Could not enable MCP server") : t("Could not disable MCP server"),
      result,
    );
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
        editorTarget.server ? t("Could not update MCP server") : t("Could not add MCP server"),
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
    openExternal(skill.url, t("Could not open skill"));
  };

  const removeServer = async (server: McpServer) => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      t("Remove '{name}'?", { name: server.name }),
      {
        variant: "destructive",
      },
    );
    if (!confirmed) return;
    setPendingServerId(server.id);
    const result = await deleteServer({ environmentId, input: { mcpServerId: server.id } });
    setPendingServerId(null);
    reportFailure(t("Could not remove MCP server"), result);
  };

  return (
    <>
      {selectedPlugin ? (
        <div className="motion-page-forward flex h-full min-h-0 flex-1 flex-col">
          <PluginDetails
            standalone={standalone}
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
              openExternal(
                integrationsShListing(selectedPlugin.id) ?? selectedPlugin.documentationUrl,
                t("Could not open integration guide"),
              )
            }
            onViewSource={() => openExternal(selectedPlugin.sourceUrl, t("Could not open source"))}
            onOpenSkill={openPluginSkill}
          />
        </div>
      ) : (
        <PluginDirectoryLayout
          standalone={standalone}
          returning={leftDirectory}
          search={<PluginSearchField query={query} onQueryChange={setQuery} />}
          filters={<PluginFilterBar filter={filter} onFilterChange={setFilter} />}
        >
          <section className="flex flex-col gap-4 rounded-2xl border border-border/70 bg-card px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="max-w-xl">
              <h2 className="text-base font-semibold">{t("Find an integration")}</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                {t(
                  "Browse integrations.sh for MCP endpoints and setup instructions. Add the server here once you have its URL or command.",
                )}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={openCustomCreator}>
                {t("Add MCP server")}
              </Button>
              <a
                className="inline-flex h-8 items-center rounded-lg bg-foreground px-3 text-sm font-medium text-background hover:opacity-85"
                href="https://integrations.sh/"
                rel="noopener noreferrer"
                target="_blank"
              >
                {t("Browse integrations.sh")}
              </a>
            </div>
          </section>
          <PluginsCatalog
            sections={sections}
            servers={servers}
            accessStatuses={subscriptionAuth.data?.access ?? []}
            pendingServerId={pendingServerId}
            onToggle={(plugin, enabled) => void togglePlugin(plugin, enabled)}
            onOpen={openPlugin}
            nothingInstalled={filter === "Installed" && query.trim() === ""}
          />
          {filter === "All" || filter === "Installed" ? (
            <ComposioSection
              environmentId={environmentId}
              query={query}
              catalog={FULL_PLUGIN_CATALOG}
              installedOnly={filter === "Installed"}
            />
          ) : null}
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
        </PluginDirectoryLayout>
      )}
      <Dialog open={editorTarget !== null} onOpenChange={(open) => !open && closeEditor()}>
        <DialogPopup className="max-h-[min(36rem,90dvh)] max-w-lg flex-col overflow-hidden">
          <DialogHeader variant="divided" className="shrink-0 px-6 py-5">
            <DialogTitle>
              {editorTarget?.server ? t("Edit MCP server") : t("Add MCP server")}
            </DialogTitle>
          </DialogHeader>
          <DialogPanel className="space-y-4 px-6 py-5">
            <Field>
              <FieldLabel>{t("Name")}</FieldLabel>
              <Input
                autoFocus
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
              />
            </Field>
            <Field>
              <FieldLabel>{t("Transport")}</FieldLabel>
              <Select
                value={draft.transport}
                onValueChange={(transport) => {
                  if (transport === "stdio" || transport === "url")
                    setDraft({ ...draft, transport });
                }}
              >
                <SelectTrigger className="w-full" aria-label={t("MCP transport")}>
                  <SelectValue>
                    {draft.transport === "stdio" ? t("Local command") : t("Remote URL")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="stdio">{t("Local command")}</SelectItem>
                  <SelectItem value="url">{t("Remote URL")}</SelectItem>
                </SelectPopup>
              </Select>
            </Field>
            {draft.transport === "stdio" ? (
              <>
                <Field>
                  <FieldLabel>{t("Command")}</FieldLabel>
                  <Input
                    value={draft.command}
                    onChange={(event) => setDraft({ ...draft, command: event.currentTarget.value })}
                    placeholder="bunx"
                  />
                </Field>
                <Field>
                  <FieldLabel>{t("Arguments, one per line")}</FieldLabel>
                  <Textarea
                    rows={4}
                    value={draft.args}
                    onChange={(event) => setDraft({ ...draft, args: event.currentTarget.value })}
                  />
                </Field>
              </>
            ) : (
              <Field>
                <FieldLabel>{t("URL")}</FieldLabel>
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
              {t("Cancel")}
            </Button>
            <Button disabled={pendingServerId !== null} onClick={() => void saveEditor()}>
              {editorTarget?.server ? t("Save") : t("Add server")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

export function PluginsDialog() {
  const { t } = useI18n();
  const open = usePluginsDialogStore((state) => state.open);
  const environmentId = usePrimaryEnvironmentId();
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && closePlugins()}>
      <DialogPopup bottomStickOnMobile={false} className={PLUGIN_DIALOG_CLASS_NAME}>
        {environmentId ? (
          <PluginsDialogForEnvironment environmentId={environmentId} />
        ) : (
          <DialogHeader>
            <DialogTitle>{t("Plugins")}</DialogTitle>
            <DialogDescription>{t("Connect an environment to manage plugins.")}</DialogDescription>
          </DialogHeader>
        )}
      </DialogPopup>
    </Dialog>
  );
}

export function PluginsPage() {
  const { t } = useI18n();
  const environmentId = usePrimaryEnvironmentId();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col text-foreground">
        {environmentId ? (
          <PluginsDialogForEnvironment environmentId={environmentId} standalone />
        ) : (
          <>
            <PluginsPageHeader />
            <div className={PLUGIN_PAGE_COLUMN_CLASS_NAME}>
              <p className="px-2.5 text-[15px] leading-6 text-muted-foreground">
                {t("Connect an environment to manage plugins.")}
              </p>
            </div>
          </>
        )}
      </div>
    </SidebarInset>
  );
}
