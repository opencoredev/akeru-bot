import { useAtomValue } from "@effect/atom-react";
import { Analytics01Icon, PlugSocketIcon, Settings02Icon } from "@hugeicons/core-free-icons";
import type { EnvironmentId, McpServer } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { memo, useCallback } from "react";
import {
  loadCatalog,
  resolveCatalogInstallations,
  type PluginDefinition,
} from "../../../../../plugins";

import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { openSettings } from "../../settingsDialogStore";
import { openPlugins } from "../../pluginsDialogStore";
import { openUsage } from "../../usageDialogStore";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { environmentMcpServersAtom } from "../../state/mcpServers";
import { AkeruMark } from "../AkeruMark";
import { T3ConnectSidebarAvatar, T3ConnectSidebarSignIn } from "../clerk/T3ConnectSidebarSignIn";
import { PluginLogoImage } from "../plugins/PluginsCatalog";
import { isBuiltinMcpServer } from "../plugins/pluginRegistry";
import { cn } from "../../lib/utils";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  resolveSidebarStageFocusRingOffsetClass,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import { AppIcon } from "../ui/app-icon";
import {
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode === "artwork",
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;

  return (
    <SidebarHeader
      className={cn(
        "@container/sidebar-header relative h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center px-3 py-0 md:px-0",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      <SidebarTrigger
        className={cn(
          "relative z-10 md:hidden",
          backdropVariant &&
            "focus-visible:ring-white/90 [&_svg]:stroke-white/90! [&_svg]:opacity-100! [&_svg]:hover:stroke-white! [:hover,[data-pressed]]:bg-white/15",
          backdropVariant && resolveSidebarStageFocusRingOffsetClass(backdropVariant),
        )}
      />
      <SidebarBrand onBackdrop={backdropVariant !== null} />
      {pillLabel ? (
        <Badge
          className="relative z-10 ml-1 rounded-full px-1.5 text-muted-foreground"
          data-environment-identification="pill"
          size="sm"
          variant="secondary"
        >
          {pillLabel}
        </Badge>
      ) : null}
    </SidebarHeader>
  );
});

function SidebarBrand({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <Link
      aria-label="Go to threads"
      className={cn(
        "relative z-10 ml-[var(--workspace-titlebar-content-left)] hidden h-7 w-fit min-w-0 shrink-0 items-center gap-1 overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2 md:flex",
        onBackdrop ? "text-white" : "text-foreground",
      )}
      to="/"
    >
      <AkeruMark aria-hidden />
      <span
        className={cn(
          "-translate-y-px truncate text-sm font-medium tracking-tight",
          onBackdrop ? "text-white/70" : "text-muted-foreground",
        )}
      >
        Akeru Bot
      </span>
    </Link>
  );
}

const PLUGIN_CATALOG = loadCatalog();

export function formatEnabledPluginStatus(enabledCount: number): string {
  if (enabledCount === 0) return "No plugins enabled";
  return `${enabledCount} ${enabledCount === 1 ? "plugin" : "plugins"} enabled`;
}

export function summarizeEnabledPlugins(
  servers: readonly McpServer[],
  catalog: readonly PluginDefinition[] = PLUGIN_CATALOG,
): { readonly enabledPlugins: readonly PluginDefinition[]; readonly enabledCount: number } {
  const enabledIds = new Set<string>(
    servers.filter((server) => server.enabled).map((server) => server.id),
  );
  const installations = resolveCatalogInstallations(servers, catalog);
  const enabledPluginIds = new Set(
    installations.flatMap((installation) =>
      installation.kind === "catalog" && enabledIds.has(installation.serverId)
        ? [installation.plugin.id]
        : [],
    ),
  );
  return {
    enabledPlugins: catalog.filter((plugin) => enabledPluginIds.has(plugin.id)),
    enabledCount:
      installations.filter((installation) => enabledIds.has(installation.serverId)).length +
      servers.filter((server) => server.enabled && !isBuiltinMcpServer(server)).length,
  };
}

function SidebarPluginSummaryForEnvironment({
  environmentId,
  onClick,
}: {
  readonly environmentId: EnvironmentId;
  readonly onClick: () => void;
}) {
  const servers = useAtomValue(environmentMcpServersAtom(environmentId));
  const { enabledCount, enabledPlugins } = summarizeEnabledPlugins(servers);
  const statusLabel = formatEnabledPluginStatus(enabledCount);

  return (
    <SidebarMenuItem>
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={`Plugins, ${statusLabel}`}
              className="h-auto min-h-12 gap-2 rounded-xl px-2 py-2 group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:min-h-8! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0!"
              onClick={onClick}
            >
              <AppIcon className="size-[18px] shrink-0" icon={PlugSocketIcon} />
              <span className="flex min-w-0 flex-1 flex-col items-start group-data-[collapsible=icon]:hidden">
                <span className="text-sm font-medium leading-5">Plugins</span>
                <span className="truncate text-xs leading-4 text-sidebar-muted-foreground">
                  {statusLabel}
                </span>
              </span>
              {enabledPlugins.length > 0 ? (
                <span
                  aria-hidden="true"
                  className="flex shrink-0 -space-x-1.5 group-data-[collapsible=icon]:hidden"
                >
                  {enabledPlugins.slice(0, 3).map((plugin) => (
                    <PluginLogoImage
                      className="size-6 rounded-md"
                      key={plugin.id}
                      plugin={plugin}
                    />
                  ))}
                </span>
              ) : null}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="right">{`Plugins · ${statusLabel}`}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

function SidebarPluginSummary({ onClick }: { readonly onClick: () => void }) {
  const environmentId = usePrimaryEnvironmentId();
  if (!environmentId) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton
          aria-label="Plugins, connect an environment to manage plugins"
          className="h-auto min-h-12 gap-2 rounded-xl px-2 py-2"
          onClick={onClick}
        >
          <AppIcon className="size-[18px] shrink-0" icon={PlugSocketIcon} />
          <span className="flex min-w-0 flex-1 flex-col items-start group-data-[collapsible=icon]:hidden">
            <span className="text-sm font-medium leading-5">Plugins</span>
            <span className="truncate text-xs leading-4 text-sidebar-muted-foreground">
              Connect an environment
            </span>
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  }
  return <SidebarPluginSummaryForEnvironment environmentId={environmentId} onClick={onClick} />;
}

function SidebarUtilityItem({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <SidebarMenuItem className="min-w-0 flex-1 group-data-[collapsible=icon]:flex-none">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={label}
              className="w-full justify-center gap-1.5 text-xs group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-0!"
              onClick={onClick}
            >
              {icon}
              <span className="group-data-[collapsible=icon]:hidden">{label}</span>
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  const { isMobile, setOpenMobile } = useSidebar();
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);
  const handlePluginsClick = useCallback(() => {
    closeMobileSidebar();
    openPlugins();
  }, [closeMobileSidebar]);
  const handleSettingsClick = useCallback(() => {
    closeMobileSidebar();
    openSettings();
  }, [closeMobileSidebar]);
  const handleUsageClick = useCallback(() => {
    closeMobileSidebar();
    openUsage();
  }, [closeMobileSidebar]);

  return (
    <SidebarFooter className="max-h-[min(45dvh,22rem)] shrink-0 overflow-y-auto overscroll-contain p-[var(--sidebar-content-inset)]">
      <div className="flex flex-col gap-2 empty:hidden group-data-[collapsible=icon]:hidden">
        <SidebarProviderUpdatePill />
        <SidebarUpdateArchitectureWarning />
      </div>
      <SidebarMenu>
        <SidebarPluginSummary onClick={handlePluginsClick} />
      </SidebarMenu>
      <div className="min-w-0 group-data-[collapsible=icon]:hidden">
        <T3ConnectSidebarSignIn />
        <T3ConnectSidebarAvatar />
      </div>
      <SidebarMenu className="flex-row items-center gap-1 group-data-[collapsible=icon]:flex-col">
        <SidebarUtilityItem
          icon={<AppIcon className="size-4" icon={Settings02Icon} />}
          label="Settings"
          onClick={handleSettingsClick}
        />
        <SidebarUtilityItem
          icon={<AppIcon className="size-4" icon={Analytics01Icon} />}
          label="Usage"
          onClick={handleUsageClick}
        />
        <SidebarUpdatePill />
      </SidebarMenu>
    </SidebarFooter>
  );
});
