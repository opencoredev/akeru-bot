import type { McpServer, McpServerId } from "@t3tools/contracts";
import { PuzzleIcon, SearchIcon, ServerIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import {
  loadCatalog,
  resolveCatalogInstallations,
  type PluginDefinition,
} from "../../../../../plugins";
import { isBuiltinMcpServer } from "../plugins/pluginRegistry";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";

const CATALOG = loadCatalog();

export interface BotToolItem {
  readonly id: McpServerId;
  readonly kind: "mcp" | "plugin";
  readonly name: string;
  readonly description: string;
  readonly workspaceEnabled: boolean;
  readonly logo?: PluginDefinition["logo"];
}

export function planBotToolToggle(
  disabledIds: readonly McpServerId[],
  id: McpServerId,
  enabled: boolean,
): readonly McpServerId[] {
  const next = new Set(disabledIds);
  if (enabled) next.delete(id);
  else next.add(id);
  return [...next];
}

function mcpDescription(server: McpServer): string {
  return server.transport === "url"
    ? server.url
    : [server.command, ...(server.args ?? [])].join(" ");
}

export function buildBotToolItems(
  servers: readonly McpServer[],
  catalog: readonly PluginDefinition[] = CATALOG,
): readonly BotToolItem[] {
  const serversById = new Map<string, McpServer>(servers.map((server) => [server.id, server]));
  const plugins = resolveCatalogInstallations(servers, catalog).flatMap((installation) => {
    const server = serversById.get(installation.serverId);
    if (!server?.enabled) return [];
    return installation.kind === "catalog"
      ? [
          {
            id: server.id,
            kind: "plugin" as const,
            name: installation.plugin.title,
            description: installation.plugin.description,
            workspaceEnabled: true,
            logo: installation.plugin.logo,
          },
        ]
      : [
          {
            id: server.id,
            kind: "plugin" as const,
            name: installation.title,
            description: mcpDescription(server),
            workspaceEnabled: true,
          },
        ];
  });
  const mcpServers = servers
    .filter((server) => server.enabled && !isBuiltinMcpServer(server))
    .map((server) => ({
      id: server.id,
      kind: "mcp" as const,
      name: server.name,
      description: mcpDescription(server),
      workspaceEnabled: true,
    }));
  return [...plugins, ...mcpServers].toSorted(
    (left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name),
  );
}

export function isBotToolEnabled(
  item: Pick<BotToolItem, "id" | "workspaceEnabled">,
  disabledIds: readonly McpServerId[],
): boolean {
  return item.workspaceEnabled && !disabledIds.includes(item.id);
}

function ToolRow({
  item,
  enabled,
  onToggle,
}: {
  readonly item: BotToolItem;
  readonly enabled: boolean;
  readonly onToggle: (enabled: boolean) => void;
}) {
  return (
    <div className="flex min-h-14 items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted/40">
      <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-background text-muted-foreground">
        {item.logo ? (
          <picture>
            {item.logo.darkSrc ? (
              <source media="(prefers-color-scheme: dark)" srcSet={item.logo.darkSrc} />
            ) : null}
            <img src={item.logo.src} alt="" className="size-6 object-contain" />
          </picture>
        ) : (
          <ServerIcon className="size-4" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{item.name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {item.workspaceEnabled ? item.description : "Disabled for the workspace"}
        </span>
      </span>
      <Switch
        checked={enabled}
        disabled={!item.workspaceEnabled}
        onCheckedChange={(checked) => onToggle(Boolean(checked))}
        aria-label={`${enabled ? "Disable" : "Enable"} ${item.name} for this bot`}
      />
    </div>
  );
}

export function BotToolsSheet({
  open,
  onOpenChange,
  servers,
  disabledIds,
  onDisabledIdsChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly servers: readonly McpServer[];
  readonly disabledIds: readonly McpServerId[];
  readonly onDisabledIdsChange: (ids: readonly McpServerId[]) => void;
}) {
  const [query, setQuery] = useState("");
  const items = useMemo(() => buildBotToolItems(servers), [servers]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onOpenChange, open]);
  const needle = query.trim().toLowerCase();
  const visible = items.filter(
    (item) =>
      needle.length === 0 ||
      item.name.toLowerCase().includes(needle) ||
      item.description.toLowerCase().includes(needle),
  );
  const plugins = visible.filter((item) => item.kind === "plugin");
  const mcpServers = visible.filter((item) => item.kind === "mcp");
  const workspaceEnabledIds = items.filter((item) => item.workspaceEnabled).map((item) => item.id);

  const toggle = (id: McpServerId, enabled: boolean) => {
    onDisabledIdsChange(planBotToolToggle(disabledIds, id, enabled));
  };

  const section = (title: string, sectionItems: readonly BotToolItem[]) =>
    sectionItems.length > 0 ? (
      <section className="mt-5" aria-label={title}>
        <div className="mb-1 flex items-center gap-2 px-2 text-xs font-medium text-muted-foreground">
          {title === "Plugins" ? (
            <PuzzleIcon className="size-3.5" />
          ) : (
            <ServerIcon className="size-3.5" />
          )}
          {title}
        </div>
        <div className="space-y-0.5">
          {sectionItems.map((item) => (
            <ToolRow
              key={item.id}
              item={item}
              enabled={isBotToolEnabled(item, disabledIds)}
              onToggle={(enabled) => toggle(item.id, enabled)}
            />
          ))}
        </div>
      </section>
    ) : null;

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[70] flex justify-end" role="presentation">
      <button
        type="button"
        aria-label="Close bot tools"
        className="absolute inset-0 bg-background/60 backdrop-blur-xs"
        onClick={() => onOpenChange(false)}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="bot-tools-title"
        className="pb-safe pt-safe relative flex h-full w-[min(92vw,30rem)] min-h-0 flex-col border-s border-border bg-popover text-popover-foreground shadow-xl"
      >
        <header className="border-b border-border px-5 pb-4 pt-5">
          <div className="flex items-center justify-between gap-3">
            <h2 id="bot-tools-title" className="text-base font-semibold">
              Tools
            </h2>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Close bot tools"
              onClick={() => onOpenChange(false)}
            >
              <XIcon className="size-4" />
            </Button>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose which workspace tools this bot can use.
          </p>
          <div className="mt-4 flex items-center gap-2">
            <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-input bg-background px-2.5 focus-within:ring-2 focus-within:ring-ring">
              <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Search tools"
                aria-label="Search bot tools"
                className="border-0 px-0 shadow-none focus-visible:ring-0"
              />
            </label>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                onDisabledIdsChange(disabledIds.filter((id) => !workspaceEnabledIds.includes(id)))
              }
            >
              Enable all
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                onDisabledIdsChange([...new Set([...disabledIds, ...workspaceEnabledIds])])
              }
            >
              Disable all
            </Button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6">
          {visible.length === 0 ? (
            <p className="px-2 py-10 text-center text-sm text-muted-foreground">
              {items.length === 0
                ? "No workspace tools are installed."
                : "No tools match your search."}
            </p>
          ) : (
            <>
              {section("Plugins", plugins)}
              {section("MCP servers", mcpServers)}
            </>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
