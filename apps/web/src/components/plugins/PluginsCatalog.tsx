import type { McpServer, ProviderAccessStatus } from "@akeru/contracts";
import type { PluginDirectoryDefinition } from "../../../../../plugins";
import { useI18n } from "../../i18n";
import { DirectorySection, PluginCard } from "./PluginCatalogCards";
import { pluginLabel } from "./pluginLabel";
import { findPluginServer, pluginMcpServerId } from "./pluginRegistry";
import type { PluginSection } from "./pluginPresentation";

export { ComposioToolkitResults } from "./ComposioToolkitResults";

export { CustomMcpServers, RemovedBuiltinServers } from "./CustomMcpServers";

export { PluginLogoImage } from "./PluginCatalogCards";

export { pluginLabel } from "./pluginLabel";

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
        <p className="mt-1 text-13px text-muted-foreground">
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
