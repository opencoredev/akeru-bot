import {
  Delete02Icon,
  PencilEdit02Icon,
  PlusSignIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import type { ComposioToolkit, McpServer, ProviderAccessStatus } from "@akeru/contracts";
import type { ReactNode } from "react";
import type { PluginDirectoryDefinition } from "../../../../../plugins";
import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";
import { AppIcon } from "../ui/app-icon";
import { Button } from "../ui/button";
import { findPluginServer, pluginMcpServerId } from "./pluginRegistry";
import {
  pluginBrokerName,
  pluginConnectionLabel,
  pluginPrimaryAction,
  type PluginPrimaryAction,
  type PluginSection,
} from "./pluginPresentation";

type Translate = ReturnType<typeof useI18n>["t"];

/**
 * Translates the fixed labels that `pluginPresentation` returns: filters,
 * categories, section titles, primary actions, and connection kinds. Any other
 * text (catalog data) passes through unchanged.
 */
export function pluginLabel(label: string, t: Translate): string {
  switch (label) {
    case "All":
      return t("All");
    case "Featured":
      return t("Featured");
    case "Installed":
      return t("Installed");
    case "Search results":
      return t("Search results");
    case "Work":
      return t("Work");
    case "Web":
      return t("Web");
    case "Marketing":
      return t("Marketing");
    case "Build":
      return t("Build");
    case "Design":
      return t("Design");
    case "Sales":
      return t("Sales");
    case "Support":
      return t("Support");
    case "Commerce":
      return t("Commerce");
    case "Add":
      return t("Add");
    case "Connect":
      return t("Connect");
    case "Add key":
      return t("Add key");
    case "Disable":
      return t("Disable");
    case "Reconnect":
      return t("Reconnect");
    case "Approval pending":
      return t("Approval pending");
    case "Verification pending":
      return t("Verification pending");
    case "Local":
      return t("Local");
    case "API key":
      return t("API key");
    case "No sign-in":
      return t("No sign-in");
    default:
      return label;
  }
}

const LOGO_TILE_CLASS_NAME =
  "flex shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-muted/70 p-2 ring-1 ring-border/50 ring-inset";
const ROW_CLASS_NAME =
  "group flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2.5 transition-colors hover:bg-muted/50";
const ACTION_CLASS_NAME = "h-8 min-w-[4.5rem] shrink-0 rounded-full px-3.5 text-[13px]";
const LOGO_SIZE_CLASS_NAME = "size-11 rounded-xl";

export function PluginLogoImage({
  plugin,
  className = "size-10",
}: {
  readonly plugin: PluginDirectoryDefinition;
  readonly className?: string;
}) {
  return (
    <span aria-hidden="true" className={cn(LOGO_TILE_CLASS_NAME, className)}>
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

function McpLogo() {
  return (
    <span aria-hidden="true" className={cn(LOGO_TILE_CLASS_NAME, "size-10")}>
      <img alt="" className="size-full object-contain dark:hidden" src="/plugin-logos/mcp.svg" />
      <img
        alt=""
        className="hidden size-full object-contain dark:block"
        src="/plugin-logos/mcp-dark.svg"
      />
    </span>
  );
}

/** Name, quiet meta, and a short description for one directory row. */
function RowText({
  title,
  meta,
  description,
}: {
  readonly title: string;
  readonly meta?: readonly (string | null | false | undefined)[];
  readonly description: string;
}) {
  const metaText = (meta ?? []).filter(Boolean).join(" · ");
  return (
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-baseline gap-2">
        <h3 className="truncate text-sm font-medium leading-5 text-foreground">{title}</h3>
        {metaText ? (
          <span className="shrink-0 truncate text-xs text-muted-foreground/80">{metaText}</span>
        ) : null}
      </div>
      <p className="line-clamp-2 text-[13px] leading-5 text-muted-foreground sm:line-clamp-1">
        {description}
      </p>
    </div>
  );
}

const CARD_GRID_CLASS_NAME = {
  grid: "grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3",
  // Featured holds a handful of picks, so it runs one column wider.
  featured: "grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4",
  list: "flex flex-col gap-0.5",
};

/** Groups cards (or rows) under a section heading with a quiet count. */
function DirectorySection({
  label,
  labelId,
  count,
  trailing,
  layout = "grid",
  children,
}: {
  readonly label: string;
  readonly labelId?: string;
  readonly count?: number;
  readonly trailing?: ReactNode;
  readonly layout?: keyof typeof CARD_GRID_CLASS_NAME;
  readonly children: ReactNode;
}) {
  return (
    <section {...(labelId ? { "aria-labelledby": labelId } : { "aria-label": label })}>
      <div className="mb-3 flex h-7 items-center justify-between gap-3 px-1">
        <h2
          className="flex items-baseline gap-2 text-[15px] font-semibold text-foreground"
          id={labelId}
        >
          {label}
          {count !== undefined ? (
            <span className="text-xs font-normal tabular-nums text-muted-foreground/70">
              {count}
            </span>
          ) : null}
        </h2>
        {trailing}
      </div>
      <div className={CARD_GRID_CLASS_NAME[layout]}>{children}</div>
    </section>
  );
}

const CARD_CLASS_NAME =
  "group relative flex min-h-34 min-w-0 flex-col rounded-2xl border border-border/70 bg-card p-4 shadow-[0_1px_2px_rgb(0_0_0/3%)] transition-[border-color,background-color,box-shadow] duration-(--duration-fast) ease-(--ease-smooth-out) hover:border-border hover:shadow-[0_1px_2px_rgb(0_0_0/4%),0_6px_16px_-8px_rgb(0_0_0/12%)] motion-reduce:transition-none has-[[data-card-open]:focus-visible]:ring-2 has-[[data-card-open]:focus-visible]:ring-ring";

/** One directory card. The whole card opens details; the action sits above that hit area. */
function DirectoryCard({
  id,
  logo,
  title,
  description,
  status,
  openLabel,
  onOpen,
  action,
}: {
  readonly id: { readonly [key: `data-${string}`]: string };
  readonly logo: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly status: readonly (string | null | false | undefined)[];
  readonly openLabel?: string;
  readonly onOpen?: () => void;
  readonly action: ReactNode;
}) {
  const statusText = status.filter(Boolean).join(" · ");
  return (
    <article className={CARD_CLASS_NAME} {...id}>
      {onOpen ? (
        <button
          aria-label={openLabel}
          className="absolute inset-0 cursor-pointer rounded-2xl outline-hidden"
          data-card-open=""
          type="button"
          onClick={onOpen}
        />
      ) : null}
      <div className="pointer-events-none flex min-w-0 items-start gap-3">
        {logo}
        <div className="min-w-0 flex-1 pt-0.5">
          <h3 className="truncate text-sm font-semibold leading-5 text-foreground">{title}</h3>
          <p className="mt-1 line-clamp-2 text-[13px] leading-5 text-muted-foreground">
            {description}
          </p>
        </div>
      </div>
      <div className="mt-auto flex min-h-8 items-end justify-between gap-3 pt-4">
        <span className="pointer-events-none min-w-0 truncate text-xs text-muted-foreground/80">
          {statusText}
        </span>
        <div className="relative">{action}</div>
      </div>
    </article>
  );
}

interface PluginsCatalogProps {
  readonly sections: readonly PluginSection[];
  readonly servers: readonly McpServer[];
  readonly accessStatuses?: readonly ProviderAccessStatus[];
  readonly pendingServerId: string | null;
  readonly onToggle: (plugin: PluginDirectoryDefinition, enabled: boolean) => void;
  readonly onOpen: (plugin: PluginDirectoryDefinition) => void;
  /** An empty Installed view with no search means nothing is connected yet. */
  readonly nothingInstalled?: boolean;
}

const EMPTY_PROVIDER_ACCESS_STATUSES: readonly ProviderAccessStatus[] = [];

function actionVariant(action: PluginPrimaryAction) {
  return action.enable === true ? "outline" : "ghost-muted";
}

function PluginCard({
  plugin,
  server,
  accessStatus,
  pending,
  onToggle,
  onOpen,
}: {
  readonly plugin: PluginDirectoryDefinition;
  readonly server: McpServer | undefined;
  readonly accessStatus: ProviderAccessStatus | undefined;
  readonly pending: boolean;
  readonly onToggle: (enabled: boolean) => void;
  readonly onOpen: () => void;
}) {
  const { t } = useI18n();
  const action = pluginPrimaryAction(plugin, server, accessStatus);
  const actionLabel = pluginLabel(action.label, t);
  const brokerName = pluginBrokerName(plugin);
  const awaitingVendor =
    plugin.connection.type === "approval-pending" ||
    plugin.connection.type === "verification-pending";
  const connected = server?.enabled === true && action.enable === false;
  return (
    <DirectoryCard
      id={{ "data-plugin-id": plugin.id }}
      logo={<PluginLogoImage plugin={plugin} className={LOGO_SIZE_CLASS_NAME} />}
      title={plugin.title}
      description={plugin.description}
      status={[
        connected && t("Connected"),
        awaitingVendor && pluginLabel(pluginConnectionLabel(plugin), t),
        brokerName && t("via {name}", { name: brokerName }),
      ]}
      openLabel={t("Open {name}", { name: plugin.title })}
      onOpen={onOpen}
      action={
        <Button
          aria-label={t("{action} {name}", { action: actionLabel, name: plugin.title })}
          className={ACTION_CLASS_NAME}
          size="sm"
          variant={actionVariant(action)}
          disabled={pending || action.enable === null}
          title={action.blocker}
          onClick={() => action.enable !== null && onToggle(action.enable)}
        >
          {actionLabel}
        </Button>
      }
    />
  );
}

export function PluginsCatalog({
  sections,
  servers,
  accessStatuses = EMPTY_PROVIDER_ACCESS_STATUSES,
  pendingServerId,
  onToggle,
  onOpen,
  nothingInstalled = false,
}: PluginsCatalogProps) {
  const { t } = useI18n();
  const resultCount = sections.reduce((count, section) => count + section.plugins.length, 0);
  if (resultCount === 0) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm font-medium text-foreground">
          {nothingInstalled ? t("No plugins connected yet") : t("No plugins match")}
        </p>
        <p className="mt-1 text-[13px] text-muted-foreground">
          {nothingInstalled
            ? t("Connect one from All and it shows up here.")
            : t("Try another name or clear the filter.")}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-10">
      {sections.map((section) => (
        <DirectorySection
          count={section.plugins.length}
          key={section.title}
          label={pluginLabel(section.title, t)}
          layout={section.title === "Featured" ? "featured" : "grid"}
        >
          {section.plugins.map((plugin) => {
            const server = findPluginServer(plugin, servers);
            return (
              <PluginCard
                key={`${section.title}:${plugin.id}`}
                plugin={plugin}
                server={server}
                accessStatus={accessStatuses.find((status) => status.pluginId === plugin.id)}
                pending={pendingServerId === pluginMcpServerId(plugin)}
                onToggle={(enabled) => onToggle(plugin, enabled)}
                onOpen={() => onOpen(plugin)}
              />
            );
          })}
        </DirectorySection>
      ))}
    </div>
  );
}

export function ComposioToolkitResults({
  toolkits,
  connectedToolkitIds,
  pendingToolkitId,
  onConnect,
}: {
  readonly toolkits: readonly ComposioToolkit[];
  readonly connectedToolkitIds: ReadonlySet<string>;
  readonly pendingToolkitId: string | null;
  readonly onConnect: (toolkit: ComposioToolkit) => void;
}) {
  const { t, plural } = useI18n();
  if (toolkits.length === 0) return null;
  return (
    <DirectorySection count={toolkits.length} label={t("From Composio")}>
      {toolkits.map((toolkit) => {
        const connected = connectedToolkitIds.has(toolkit.slug);
        return (
          <DirectoryCard
            key={toolkit.slug}
            id={{ "data-composio-toolkit": toolkit.slug }}
            logo={
              <span className={cn(LOGO_TILE_CLASS_NAME, LOGO_SIZE_CLASS_NAME)}>
                {toolkit.logoUrl ? (
                  <img alt="" className="size-full object-contain" src={toolkit.logoUrl} />
                ) : (
                  <span aria-hidden="true" className="text-sm font-medium text-muted-foreground">
                    {toolkit.name.slice(0, 1).toUpperCase()}
                  </span>
                )}
              </span>
            }
            title={toolkit.name}
            description={
              toolkit.description ??
              plural(toolkit.toolsCount, { one: "{count} tool", other: "{count} tools" })
            }
            status={[t("via Composio")]}
            action={
              <Button
                aria-label={t("{action} {name}", {
                  action: connected ? t("Connected") : t("Connect"),
                  name: toolkit.name,
                })}
                className={ACTION_CLASS_NAME}
                disabled={connected || pendingToolkitId === toolkit.slug}
                size="sm"
                variant={connected ? "ghost-muted" : "outline"}
                onClick={() => onConnect(toolkit)}
              >
                {connected ? t("Connected") : t("Connect")}
              </Button>
            }
          />
        );
      })}
    </DirectorySection>
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
  const { t } = useI18n();
  if (servers.length === 0) return null;
  return (
    <DirectorySection
      count={servers.length}
      label={t("Removed plugins")}
      labelId="removed-plugins-title"
      layout="list"
    >
      {servers.map((server) => (
        <div className={ROW_CLASS_NAME} key={server.id}>
          <McpLogo />
          <RowText
            title={server.name}
            description={t("No longer in the directory · {status}", {
              status: server.enabled ? t("Enabled") : t("Disabled"),
            })}
          />
          <Button
            aria-label={t("Remove {name}", { name: server.name })}
            className={ACTION_CLASS_NAME}
            size="sm"
            variant="ghost-muted"
            disabled={pendingServerId === server.id}
            onClick={() => onDelete(server)}
          >
            {t("Remove")}
          </Button>
        </div>
      ))}
    </DirectorySection>
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
  readonly onCreate: () => void;
  readonly onToggle: (server: McpServer, enabled: boolean) => void;
  readonly onEdit: (server: McpServer) => void;
  readonly onDelete: (server: McpServer) => void;
}

export function CustomMcpServers({
  servers,
  pendingServerId,
  onCreate,
  onToggle,
  onEdit,
  onDelete,
}: CustomMcpServersProps) {
  const { t } = useI18n();
  return (
    <DirectorySection
      count={servers.length}
      label={t("Custom MCP servers")}
      labelId="custom-mcp-title"
      layout="list"
      trailing={
        <Button className="h-7 rounded-full" size="sm" variant="ghost-muted" onClick={onCreate}>
          <AppIcon icon={PlusSignIcon} className="size-3.5" />
          {t("Add server")}
        </Button>
      }
    >
      {servers.length === 0 ? (
        <p className="px-2.5 py-3 text-[13px] text-muted-foreground">
          {t("Add a local command or remote URL to use your own MCP server.")}
        </p>
      ) : null}
      {servers.map((server) => {
        const pending = pendingServerId === server.id;
        return (
          <div className={ROW_CLASS_NAME} key={server.id}>
            <McpLogo />
            <RowText
              title={server.name}
              meta={[server.enabled && t("Connected")]}
              description={serverDescription(server)}
            />
            <Button
              aria-label={t("Edit {name}", { name: server.name })}
              className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 max-sm:opacity-100"
              size="icon-sm"
              variant="ghost-muted"
              disabled={pending}
              onClick={() => onEdit(server)}
            >
              <AppIcon icon={PencilEdit02Icon} className="size-4" />
            </Button>
            <Button
              aria-label={t("Delete {name}", { name: server.name })}
              className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 max-sm:opacity-100"
              size="icon-sm"
              variant="ghost-muted"
              disabled={pending}
              onClick={() => onDelete(server)}
            >
              <AppIcon icon={Delete02Icon} className="size-4" />
            </Button>
            <Button
              aria-label={
                server.enabled
                  ? t("Disable {name}", { name: server.name })
                  : t("Enable {name}", { name: server.name })
              }
              className={ACTION_CLASS_NAME}
              size="sm"
              variant={server.enabled ? "ghost-muted" : "outline"}
              disabled={pending}
              onClick={() => onToggle(server, !server.enabled)}
            >
              {server.enabled ? <AppIcon icon={Tick02Icon} className="size-3.5" /> : null}
              {server.enabled ? t("Added") : t("Add")}
            </Button>
          </div>
        );
      })}
    </DirectorySection>
  );
}
