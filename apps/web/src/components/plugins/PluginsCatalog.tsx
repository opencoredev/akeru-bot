import type { McpServer } from "@t3tools/contracts";
import { CheckIcon, ChevronRightIcon, PencilIcon, Trash2Icon } from "lucide-react";
import type { PluginDirectoryDefinition } from "../../../../../plugins";
import { Button } from "../ui/button";
import { findPluginServer, pluginMcpServerId } from "./pluginRegistry";
import { pluginBlocker, pluginPrimaryAction, type PluginSection } from "./pluginPresentation";

export function PluginLogoImage({
  plugin,
  className = "size-10",
}: {
  readonly plugin: PluginDirectoryDefinition;
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`${className} flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted p-2`}
    >
      <img
        alt=""
        className={`size-full object-contain ${plugin.logo.darkSrc ? "dark:hidden" : ""}`}
        src={plugin.logo.src}
      />
      {plugin.logo.darkSrc ? (
        <img
          alt=""
          className="hidden size-full object-contain dark:block"
          src={plugin.logo.darkSrc}
        />
      ) : null}
    </span>
  );
}

interface PluginsCatalogProps {
  readonly sections: readonly PluginSection[];
  readonly servers: readonly McpServer[];
  readonly pendingServerId: string | null;
  readonly onToggle: (plugin: PluginDirectoryDefinition, enabled: boolean) => void;
  readonly onOpen: (plugin: PluginDirectoryDefinition) => void;
}

function PluginRow({
  plugin,
  server,
  pending,
  onToggle,
  onOpen,
}: {
  readonly plugin: PluginDirectoryDefinition;
  readonly server: McpServer | undefined;
  readonly pending: boolean;
  readonly onToggle: (enabled: boolean) => void;
  readonly onOpen: () => void;
}) {
  const action = pluginPrimaryAction(plugin, server);
  const blocker = pluginBlocker(plugin);
  return (
    <article
      className="group flex min-w-0 items-center rounded-xl pe-2.5 transition-colors hover:bg-muted/45"
      data-plugin-id={plugin.id}
    >
      <button
        aria-label={`Open ${plugin.title}`}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2.5 text-start outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        type="button"
        onClick={onOpen}
      >
        <PluginLogoImage plugin={plugin} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-sm font-medium leading-5">{plugin.title}</h3>
            <span className="shrink-0 text-[11px] text-muted-foreground">{plugin.category}</span>
          </div>
          <p
            className={`truncate text-xs leading-5 ${blocker ? "text-destructive-foreground" : "text-muted-foreground"}`}
          >
            {blocker ?? plugin.description}
          </p>
        </div>
        <ChevronRightIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
        />
      </button>
      <Button
        aria-label={`${action.label} ${plugin.title}`}
        className="h-7 min-w-14 rounded-full px-3 text-xs"
        size="sm"
        variant="secondary"
        disabled={pending || action.enable === null}
        title={action.blocker}
        onClick={() => action.enable !== null && onToggle(action.enable)}
      >
        {action.label}
      </Button>
    </article>
  );
}

export function PluginsCatalog({
  sections,
  servers,
  pendingServerId,
  onToggle,
  onOpen,
}: PluginsCatalogProps) {
  const resultCount = sections.reduce((count, section) => count + section.plugins.length, 0);
  if (resultCount === 0) {
    return (
      <p className="py-14 text-center text-sm text-muted-foreground">No directory plugins match.</p>
    );
  }
  return (
    <div className="space-y-7">
      {sections.map((section) => (
        <section aria-label={section.title} key={section.title}>
          <div className="mb-2 flex items-center justify-between px-2">
            <h2 className="text-xs font-medium text-muted-foreground">{section.title}</h2>
          </div>
          <div className="grid grid-cols-1 gap-x-7 md:grid-cols-2">
            {section.plugins.map((plugin) => {
              const server = findPluginServer(plugin, servers);
              return (
                <PluginRow
                  key={`${section.title}:${plugin.id}`}
                  plugin={plugin}
                  server={server}
                  pending={pendingServerId === pluginMcpServerId(plugin)}
                  onToggle={(enabled) => onToggle(plugin, enabled)}
                  onOpen={() => onOpen(plugin)}
                />
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

export function RemovedBuiltinServers({
  servers,
  pendingServerId,
  onDelete,
}: {
  readonly servers: readonly McpServer[];
  readonly pendingServerId: string | null;
  readonly onDelete: (server: McpServer) => void;
}) {
  if (servers.length === 0) return null;
  return (
    <section aria-labelledby="removed-plugins-title">
      <div className="mb-2 flex items-center justify-between px-2">
        <h2 className="text-xs font-medium text-muted-foreground" id="removed-plugins-title">
          Removed plugins
        </h2>
        <span className="text-xs text-muted-foreground">{servers.length}</span>
      </div>
      <div className="grid grid-cols-1 gap-x-7 md:grid-cols-2">
        {servers.map((server) => (
          <div className="flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2.5" key={server.id}>
            <span
              aria-hidden="true"
              className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted p-2"
            >
              <img alt="" className="size-full object-contain" src="/plugin-logos/mcp.svg" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{server.name}</p>
              <p className="truncate text-xs leading-5 text-muted-foreground">
                No longer in the directory · {server.enabled ? "Enabled" : "Disabled"}
              </p>
            </div>
            <Button
              aria-label={`Remove ${server.name}`}
              className="h-7 rounded-full px-3 text-xs"
              size="sm"
              variant="secondary"
              disabled={pendingServerId === server.id}
              onClick={() => onDelete(server)}
            >
              Remove
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}

function serverDescription(server: McpServer): string {
  return server.transport === "url"
    ? server.url
    : [server.command, ...(server.args ?? [])].join(" ");
}

interface CustomMcpServersProps {
  readonly servers: readonly McpServer[];
  readonly pendingServerId: string | null;
  readonly onToggle: (server: McpServer, enabled: boolean) => void;
  readonly onEdit: (server: McpServer) => void;
  readonly onDelete: (server: McpServer) => void;
}

export function CustomMcpServers({
  servers,
  pendingServerId,
  onToggle,
  onEdit,
  onDelete,
}: CustomMcpServersProps) {
  if (servers.length === 0) return null;
  return (
    <section aria-labelledby="custom-mcp-title">
      <div className="mb-2 flex items-center justify-between px-2">
        <h2 className="text-xs font-medium text-muted-foreground" id="custom-mcp-title">
          Custom MCP servers
        </h2>
        <span className="text-xs text-muted-foreground">{servers.length}</span>
      </div>
      <div className="grid grid-cols-1 gap-x-7 md:grid-cols-2">
        {servers.map((server) => {
          const pending = pendingServerId === server.id;
          return (
            <div
              className="group flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2.5 transition-colors hover:bg-muted/45"
              key={server.id}
            >
              <span
                aria-hidden="true"
                className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted p-2"
              >
                <img
                  alt=""
                  className="size-full object-contain dark:hidden"
                  src="/plugin-logos/mcp.svg"
                />
                <img
                  alt=""
                  className="hidden size-full object-contain dark:block"
                  src="/plugin-logos/mcp-dark.svg"
                />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{server.name}</p>
                <p className="truncate text-xs leading-5 text-muted-foreground">
                  {serverDescription(server)}
                </p>
              </div>
              <Button
                aria-label={`Edit ${server.name}`}
                className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 max-sm:opacity-100"
                size="icon-sm"
                variant="ghost-muted"
                disabled={pending}
                onClick={() => onEdit(server)}
              >
                <PencilIcon className="size-3.5" />
              </Button>
              <Button
                aria-label={`Delete ${server.name}`}
                className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 max-sm:opacity-100"
                size="icon-sm"
                variant="ghost-muted"
                disabled={pending}
                onClick={() => onDelete(server)}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
              <Button
                aria-label={`${server.enabled ? "Disable" : "Enable"} ${server.name}`}
                className="h-7 min-w-14 rounded-full px-3 text-xs"
                size="sm"
                variant="secondary"
                disabled={pending}
                onClick={() => onToggle(server, !server.enabled)}
              >
                {server.enabled ? <CheckIcon className="size-3.5" /> : null}
                {server.enabled ? "Added" : "Add"}
              </Button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
