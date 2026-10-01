import {
  Delete02Icon,
  PencilEdit02Icon,
  PlusSignIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import type { McpServer } from "@akeru/contracts";
import { useI18n } from "../../i18n";
import { AppIcon } from "../ui/app-icon";
import { Button } from "../ui/button";
import { DirectorySection, McpLogo, ROW_CLASS_NAME, RowText } from "./PluginCatalogCards";

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
            className="min-w-18 shrink-0"
            size="pill"
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
        <Button size="pill-short" variant="ghost-muted" onClick={onCreate}>
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
              className="min-w-18 shrink-0"
              size="pill"
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
