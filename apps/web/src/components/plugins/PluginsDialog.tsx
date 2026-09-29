import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  McpServerId,
  type EnvironmentId,
  type McpServer,
  type ProviderAccessStatus,
} from "@t3tools/contracts";
import { Cancel01Icon, PuzzleIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { useChangedSinceMount } from "../../hooks/useChangedSinceMount";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  integrationsShListing,
  isInstallablePlugin,
  isListedIntegration,
  loadDirectoryCatalog,
  type PluginDirectoryDefinition,
  type PluginSkill,
} from "../../../../../plugins";
import { isElectron } from "../../env";
import { ensureLocalApi } from "../../localApi";
import { cn, randomUUID } from "../../lib/utils";
import { closePlugins, usePluginsDialogStore } from "../../pluginsDialogStore";
import { environmentBotsAtom } from "../../state/bots";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { environmentMcpServersAtom, mcpServerEnvironment } from "../../state/mcpServers";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { AppIcon } from "../ui/app-icon";
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
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { ComposioSection } from "./ComposioSection";
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
  buildPluginFilters,
  buildPluginSections,
  pluginActiveDependentBotNames,
  pluginBlocker,
  type PluginFilter,
} from "./pluginPresentation";

const ALL_CATEGORIES_VALUE = "all-categories";
const PRIMARY_FILTERS = ["All", "Featured", "Installed"] as const satisfies readonly PluginFilter[];

// The directory lists only integrations.sh entries, but an installed plugin that later
// drops off that list (for example, pending vendor verification) must stay manageable.
const FULL_CATALOG = loadDirectoryCatalog();
const CATALOG = FULL_CATALOG.filter(isListedIntegration);
export const PLUGIN_DIRECTORY_FILTERS = buildPluginFilters(CATALOG);

export function resolvePluginDialogServers(
  servers: readonly McpServer[],
  catalog: readonly PluginDirectoryDefinition[] = FULL_CATALOG,
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
export const PLUGIN_PAGE_COLUMN_CLASS_NAME =
  "mx-auto flex w-full max-w-6xl flex-col px-4 pt-0 pb-16 sm:px-10 sm:pt-1";

function isPrimaryFilter(filter: PluginFilter): filter is (typeof PRIMARY_FILTERS)[number] {
  return (PRIMARY_FILTERS as readonly PluginFilter[]).includes(filter);
}

/** Toolbar search field: card fill with a leading icon. */
function PluginSearchField({
  query,
  onQueryChange,
}: {
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
}) {
  return (
    <div className="relative">
      <AppIcon
        icon={Search01Icon}
        className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <input
        aria-label="Search plugins"
        autoComplete="off"
        className="h-9 w-full rounded-xl border border-border/80 bg-card ps-9 pe-9 text-sm text-foreground shadow-xs outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring/60 focus-visible:ring-3 focus-visible:ring-ring/15 [&::-webkit-search-cancel-button]:appearance-none"
        placeholder="Search plugins"
        spellCheck={false}
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && query) {
            event.stopPropagation();
            onQueryChange("");
          }
        }}
      />
      {query ? (
        <button
          aria-label="Clear search"
          className="absolute end-1.5 top-1/2 flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-hidden transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          type="button"
          onClick={() => onQueryChange("")}
        >
          <AppIcon icon={Cancel01Icon} className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * Moves the segmented control's pill under the pressed button. The first placement,
 * resizes, and reappearing after a category was chosen skip the slide.
 */
function useSegmentPill(active: string | null) {
  const barRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const shownRef = useRef(false);

  useLayoutEffect(() => {
    const bar = barRef.current;
    const pill = pillRef.current;
    if (!bar || !pill) return;
    const place = (instant: boolean) => {
      const target = bar.querySelector<HTMLElement>('[aria-pressed="true"]');
      if (!target) {
        pill.style.opacity = "0";
        shownRef.current = false;
        return;
      }
      if (instant || !shownRef.current) pill.style.transition = "none";
      pill.style.translate = `${target.offsetLeft}px 0`;
      pill.style.width = `${target.offsetWidth}px`;
      pill.style.opacity = "1";
      if (pill.style.transition === "none") {
        void pill.offsetWidth;
        pill.style.transition = "";
      }
      shownRef.current = true;
    };
    place(false);
    const observer = new ResizeObserver(() => place(true));
    observer.observe(bar);
    return () => observer.disconnect();
  }, [active]);

  return { barRef, pillRef };
}

/**
 * Directory filters: a small segmented control for the three views plus one
 * category menu, so eleven categories never crowd the page.
 */
function PluginFilterBar({
  filter,
  onFilterChange,
}: {
  readonly filter: PluginFilter;
  readonly onFilterChange: (filter: PluginFilter) => void;
}) {
  const categories = PLUGIN_DIRECTORY_FILTERS.filter((item) => !isPrimaryFilter(item));
  const category = isPrimaryFilter(filter) ? null : filter;
  const { barRef, pillRef } = useSegmentPill(category ? null : filter);
  return (
    <div
      aria-label="Plugin sections and categories"
      className="flex flex-wrap items-center justify-between gap-2"
      role="group"
    >
      <div className="relative inline-flex rounded-[10px] bg-muted/70 p-0.5" ref={barRef}>
        <span
          aria-hidden="true"
          className="motion-segment-pill pointer-events-none absolute inset-y-0.5 left-0 rounded-lg bg-card opacity-0 shadow-xs ring-1 ring-border/60"
          ref={pillRef}
        />
        {PRIMARY_FILTERS.map((item) => (
          <button
            aria-pressed={filter === item}
            className={cn(
              "relative h-7 cursor-pointer rounded-lg px-3 text-[13px] outline-hidden transition-colors duration-(--duration-fast) ease-(--ease-smooth-out) focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
              filter === item
                ? "font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            key={item}
            type="button"
            onClick={() => onFilterChange(item)}
          >
            {item}
          </button>
        ))}
      </div>
      {categories.length > 0 ? (
        <Select
          value={category ?? ALL_CATEGORIES_VALUE}
          onValueChange={(value) => {
            const next = PLUGIN_DIRECTORY_FILTERS.find((item) => item === value);
            onFilterChange(next ?? "All");
          }}
        >
          <SelectTrigger
            aria-label="Plugin category"
            className={cn("h-8 rounded-lg text-[13px]", category && "text-foreground")}
            size="sm"
            variant="ghost"
          >
            <SelectValue>{category ?? "All categories"}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value={ALL_CATEGORIES_VALUE}>All categories</SelectItem>
            {categories.map((item) => (
              <SelectItem key={item} value={item}>
                {item}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : null}
    </div>
  );
}

/** The named blocker for a brokered plugin that cannot connect yet, or null when it can. */
export function pluginBrokeredBlockerNotice(plugin: PluginDirectoryDefinition) {
  const blocker = pluginBlocker(plugin);
  if (plugin.connection.type !== "brokered" || blocker === null) return null;
  return {
    type: "warning" as const,
    title: `${plugin.title} is not available yet`,
    description: blocker,
  };
}

export function pluginRecoveryNotice(pluginTitle: string, recoveryFailures: readonly string[]) {
  if (recoveryFailures.length === 0) return null;
  return {
    type: "warning" as const,
    title: `${pluginTitle} connected with a session issue`,
    description: `${recoveryFailures.join(" ")} Restart the affected bot session to retry.`,
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

/** Standalone page header shared by the directory and plugin details. */
export function PluginsPageHeader({ children }: { readonly children?: ReactNode }) {
  return (
    <WorkspacePageHeader electron={isElectron}>
      {children ?? (
        <div className="flex min-w-0 items-center gap-2">
          <AppIcon icon={PuzzleIcon} className="size-4 shrink-0 text-muted-foreground" />
          <h1 className="truncate text-sm font-medium text-foreground">Plugins</h1>
        </div>
      )}
    </WorkspacePageHeader>
  );
}

/** Places search, filters, and results in either the dialog or the workspace page. */
function PluginDirectoryLayout({
  standalone,
  search,
  filters,
  returning,
  children,
}: {
  readonly standalone: boolean;
  readonly search: ReactNode;
  readonly filters: ReactNode;
  /** True when the directory remounts after leaving plugin details. */
  readonly returning: boolean;
  readonly children: ReactNode;
}) {
  if (!standalone) {
    return (
      <>
        <DialogHeader className={PLUGIN_DIRECTORY_HEADER_CLASS_NAME}>
          <div className="pe-8">
            <DialogTitle>Plugins</DialogTitle>
          </div>
          {search}
          {filters}
        </DialogHeader>
        <DialogPanel
          className={cn(PLUGIN_DIRECTORY_PANEL_CLASS_NAME, returning && "motion-page-back")}
        >
          {children}
        </DialogPanel>
      </>
    );
  }
  return (
    <>
      <PluginsPageHeader>
        <span />
      </PluginsPageHeader>
      <ScrollArea className="min-h-0 flex-1" scrollFade>
        <div
          className={cn(
            PLUGIN_PAGE_COLUMN_CLASS_NAME,
            returning ? "motion-page-back" : "motion-section-enter",
          )}
        >
          <div className="px-1">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Plugins</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Connect a listed integration, or follow a setup guide from integrations.sh.
            </p>
          </div>
          <div className="mt-6 mb-8 flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="w-full sm:max-w-sm sm:flex-1">{search}</div>
            <div className="min-w-0 flex-1">{filters}</div>
          </div>
          <div className="space-y-10">{children}</div>
        </div>
      </ScrollArea>
    </>
  );
}

function PluginsDialogForEnvironment({
  environmentId,
  standalone = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly standalone?: boolean;
}) {
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
    plugins: CATALOG,
    query,
    filter,
    installedPluginIds: new Set(installedPlugins.map((plugin) => plugin.id)),
  });
  const validationError = validateMcpServerDraft(draft);
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
    // The catalog already disables this toggle; a direct caller still gets
    // the named blocker instead of a dead click.
    if (enabled) {
      const notice = pluginBrokeredBlockerNotice(plugin);
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
                "Could not open integration guide",
              )
            }
            onViewSource={() => openExternal(selectedPlugin.sourceUrl, "Could not open source")}
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
              <h2 className="text-base font-semibold">Find an integration</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                Browse integrations.sh for MCP endpoints and setup instructions. Add the server here
                once you have its URL or command.
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={openCustomCreator}>
                Add MCP server
              </Button>
              <a
                className="inline-flex h-8 items-center rounded-lg bg-foreground px-3 text-sm font-medium text-background hover:opacity-85"
                href="https://integrations.sh/"
                rel="noopener noreferrer"
                target="_blank"
              >
                Browse integrations.sh
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
            <ComposioSection environmentId={environmentId} query={query} catalog={FULL_CATALOG} />
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

export function PluginsPage() {
  const environmentId = usePrimaryEnvironmentId();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col text-foreground">
        {environmentId ? (
          <PluginsDialogForEnvironment environmentId={environmentId} standalone />
        ) : (
          <>
            <PluginsPageHeader />
            <div className={PLUGIN_PAGE_COLUMN_CLASS_NAME}>
              <p className="px-2.5 text-[15px] leading-6 text-muted-foreground">
                Connect an environment to manage plugins.
              </p>
            </div>
          </>
        )}
      </div>
    </SidebarInset>
  );
}
