import { useAtomValue } from "@effect/atom-react";
import {
  Analytics01Icon,
  HelpCircleIcon,
  PlugSocketIcon,
  Settings02Icon,
} from "@hugeicons/core-free-icons";
import type {
  EnvironmentId,
  McpServer,
  OrchestrationBot,
  OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { memo, useCallback, useState } from "react";
import {
  loadCatalog,
  resolveCatalogInstallations,
  type PluginDefinition,
} from "../../../../../plugins";

import { createTranslator, type PluralForms } from "@t3tools/client-runtime/i18n";

import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { useI18n } from "../../i18n";
import { openSettings } from "../../settingsDialogStore";
import { openPlugins } from "../../pluginsDialogStore";
import { openUsage } from "../../usageDialogStore";
import { openProductFeedback } from "../../productFeedbackStore";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { environmentMcpServersAtom, mcpServerEnvironment } from "../../state/mcpServers";
import { environmentSnapshotAtom } from "../../state/shell";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { AkeruWordmark } from "../AkeruWordmark";
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
import { Button } from "../ui/button";
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
  const { t } = useI18n();
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
        "@container/sidebar-header relative h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-1 px-3 py-0 md:px-2",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      <div className="relative z-10 grid min-w-0 flex-1 grid-cols-[1fr_auto_1fr] items-center group-data-[collapsible=icon]:hidden">
        <div className="flex items-center justify-start">
          <SidebarTrigger
            className={cn(
              "md:hidden",
              backdropVariant &&
                "focus-visible:ring-white/90 [&_svg]:stroke-white/90! [&_svg]:opacity-100! [&_svg]:hover:stroke-white! [:hover,[data-pressed]]:bg-white/15",
              backdropVariant && resolveSidebarStageFocusRingOffsetClass(backdropVariant),
            )}
          />
        </div>
        <div className="relative flex items-center justify-center">
          <Link
            aria-label={t("Go to chats")}
            className={cn(
              "flex items-center justify-center rounded-md outline-none ring-ring focus-visible:ring-2 [-webkit-app-region:no-drag]",
              backdropVariant ? "text-white" : "text-sidebar-foreground",
            )}
            to="/"
          >
            <AkeruWordmark />
          </Link>
          {pillLabel ? (
            <Badge
              className="absolute left-full ml-2 rounded-full px-1.5 text-muted-foreground"
              data-environment-identification="pill"
              size="sm"
              variant="secondary"
            >
              {pillLabel}
            </Badge>
          ) : null}
        </div>
        <div aria-hidden />
      </div>
    </SidebarHeader>
  );
});

const PLUGIN_CATALOG = loadCatalog();
const COMPUTER_USE_SERVER_ID = "builtin-computer-use";

export interface ActiveComputerUseControl {
  readonly threadId: ThreadId;
  readonly botName: string;
}

export function findActiveComputerUseControl(input: {
  readonly threads: readonly OrchestrationThreadShell[];
  readonly bots: readonly OrchestrationBot[];
  readonly mcpServers: readonly McpServer[];
}): ActiveComputerUseControl | null {
  const server = input.mcpServers.find(
    (candidate) => candidate.id === COMPUTER_USE_SERVER_ID && candidate.enabled,
  );
  if (!server) return null;
  for (const thread of input.threads) {
    if (
      !thread.session ||
      thread.session.providerName?.toLowerCase() !== "codex" ||
      !thread.session.mcpServerIds?.includes(server.id) ||
      (thread.session.status !== "ready" && thread.session.status !== "running")
    ) {
      continue;
    }
    const botId = thread.respondingBotId ?? thread.botId;
    const bot = input.bots.find((candidate) => candidate.id === botId);
    if (!bot || bot.disabledMcpServerIds.includes(server.id)) continue;
    return { threadId: thread.id, botName: bot.name };
  }
  return null;
}

type Pluralize = (count: number, forms: PluralForms) => string;

const englishTranslator = createTranslator("en");

export function formatEnabledPluginStatus(
  enabledCount: number,
  t: (message: string) => string = englishTranslator.translate,
  plural: Pluralize = englishTranslator.plural,
): string {
  if (enabledCount === 0) return t("No plugins enabled");
  return plural(enabledCount, { one: "{count} plugin enabled", other: "{count} plugins enabled" });
}

export function formatEnabledPluginBadge(enabledCount: number): string | null {
  if (enabledCount === 0) return null;
  return enabledCount > 99 ? "99+" : String(enabledCount);
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
  const { t, plural } = useI18n();
  const servers = useAtomValue(environmentMcpServersAtom(environmentId));
  const { enabledCount } = summarizeEnabledPlugins(servers);
  const statusLabel = formatEnabledPluginStatus(enabledCount, t, plural);

  return (
    <SidebarPluginButton enabledCount={enabledCount} onClick={onClick} statusLabel={statusLabel} />
  );
}

function SidebarPluginButton({
  enabledCount,
  onClick,
  statusLabel,
}: {
  readonly enabledCount: number;
  readonly onClick: () => void;
  readonly statusLabel: string;
}) {
  const { t } = useI18n();
  const badgeLabel = formatEnabledPluginBadge(enabledCount);
  const { state } = useSidebar();
  const collapsed = state === "collapsed";

  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={t("Plugins, {status}", { status: statusLabel })}
              className="relative overflow-visible!"
              onClick={onClick}
            >
              <AppIcon className="size-4" icon={PlugSocketIcon} />
              <span className="truncate group-data-[collapsible=icon]:hidden">{t("Plugins")}</span>
              {/* Expanded, the count sits inline where it can be read as a
                  number; collapsed, it becomes the badge on the glyph. */}
              {badgeLabel ? (
                <span
                  aria-hidden="true"
                  className="ms-auto text-xs tabular-nums text-sidebar-muted-foreground group-data-[collapsible=icon]:absolute group-data-[collapsible=icon]:-right-1 group-data-[collapsible=icon]:-top-1 group-data-[collapsible=icon]:ms-0 group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:h-4 group-data-[collapsible=icon]:min-w-4 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:rounded-full group-data-[collapsible=icon]:bg-sidebar-primary group-data-[collapsible=icon]:px-1 group-data-[collapsible=icon]:text-[9px] group-data-[collapsible=icon]:font-semibold group-data-[collapsible=icon]:text-sidebar-primary-foreground"
                >
                  {badgeLabel}
                </span>
              ) : null}
            </SidebarMenuButton>
          }
        />
        {collapsed ? (
          <TooltipPopup side="right">
            {t("Plugins · {status}", { status: statusLabel })}
          </TooltipPopup>
        ) : null}
      </Tooltip>
    </SidebarMenuItem>
  );
}

function SidebarPluginSummary({ onClick }: { readonly onClick: () => void }) {
  const { t } = useI18n();
  const environmentId = usePrimaryEnvironmentId();
  if (!environmentId) {
    return (
      <SidebarPluginButton
        enabledCount={0}
        onClick={onClick}
        statusLabel={t("Connect an environment")}
      />
    );
  }
  return <SidebarPluginSummaryForEnvironment environmentId={environmentId} onClick={onClick} />;
}

function ComputerUseControlForEnvironment({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const { t } = useI18n();
  const snapshot = useAtomValue(environmentSnapshotAtom(environmentId));
  const stopSession = useAtomCommand(threadEnvironment.stopSession);
  const disableServer = useAtomCommand(mcpServerEnvironment.disable);
  const [pending, setPending] = useState(false);
  const control = snapshot
    ? findActiveComputerUseControl({
        threads: snapshot.threads,
        bots: snapshot.bots,
        mcpServers: snapshot.mcpServers ?? [],
      })
    : null;
  if (!control) return null;

  const stop = async () => {
    setPending(true);
    try {
      await stopSession({ environmentId, input: { threadId: control.threadId } });
    } finally {
      setPending(false);
    }
  };
  const revoke = async () => {
    setPending(true);
    try {
      const stopped = await stopSession({
        environmentId,
        input: { threadId: control.threadId },
      });
      if (stopped._tag === "Success") {
        await disableServer({
          environmentId,
          input: { mcpServerId: COMPUTER_USE_SERVER_ID as McpServer["id"] },
        });
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-2.5" role="status">
      <div className="flex items-center gap-2 text-xs font-medium">
        <span className="size-2 rounded-full bg-amber-500" aria-hidden="true" />
        <span className="min-w-0 truncate">
          {t("{name} controls this Mac", { name: control.botName })}
        </span>
      </div>
      <div className="mt-2 flex gap-2">
        <Button className="h-7 flex-1 text-xs" disabled={pending} size="sm" onClick={stop}>
          {t("Stop")}
        </Button>
        <Button
          aria-label={t("Revoke Computer Use for all bots")}
          className="h-7 flex-1 text-xs"
          disabled={pending}
          size="sm"
          title={t("Disable Computer Use for all bots")}
          variant="destructive-outline"
          onClick={revoke}
        >
          {t("Revoke")}
        </Button>
      </div>
    </div>
  );
}

function ComputerUseControl() {
  const environmentId = usePrimaryEnvironmentId();
  return environmentId ? <ComputerUseControlForEnvironment environmentId={environmentId} /> : null;
}

/** Status that must stay visible whatever chrome hosts it: computer use and update notices. */
export function SidebarStatusStack({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2 empty:hidden", className)}>
      <ComputerUseControl />
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
    </div>
  );
}

/**
 * A footer destination. Expanded, it reads as a labeled row — four unlabeled
 * icons asked the user to remember which glyph meant Usage and which meant
 * Feedback. Collapsed to the icon rail there is no room for the label, so the
 * tooltip carries it there and only there.
 */
export function SidebarUtilityItem({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  const { state } = useSidebar();

  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={label}
              className="group-data-[collapsible=icon]:justify-center"
              onClick={onClick}
            >
              {icon}
              <span className="truncate group-data-[collapsible=icon]:hidden">{label}</span>
            </SidebarMenuButton>
          }
        />
        {state === "collapsed" ? <TooltipPopup side="right">{label}</TooltipPopup> : null}
      </Tooltip>
    </SidebarMenuItem>
  );
}

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  const { t } = useI18n();
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
  const handleFeedbackClick = useCallback(() => {
    closeMobileSidebar();
    openProductFeedback();
  }, [closeMobileSidebar]);

  return (
    <SidebarFooter className="max-h-[min(45dvh,22rem)] shrink-0 overflow-y-auto overscroll-contain p-[var(--sidebar-content-inset)]">
      <div className="flex flex-col gap-2 empty:hidden group-data-[collapsible=icon]:hidden">
        <ComputerUseControl />
        <SidebarProviderUpdatePill />
        <SidebarUpdateArchitectureWarning />
      </div>
      {/* A labeled column, not a row of glyphs: each destination gets a
          full-width row with a comfortable hit target. The icon rail collapses
          it back to centered icons. */}
      <SidebarMenu className="flex-col flex-nowrap gap-0.5 overflow-visible">
        <SidebarPluginSummary onClick={handlePluginsClick} />
        <SidebarUtilityItem
          icon={<AppIcon className="size-4" icon={Analytics01Icon} />}
          label={t("Usage")}
          onClick={handleUsageClick}
        />
        <SidebarUtilityItem
          icon={<AppIcon className="size-4" icon={Settings02Icon} />}
          label={t("Settings")}
          onClick={handleSettingsClick}
        />
        <SidebarUtilityItem
          icon={<AppIcon className="size-4" icon={HelpCircleIcon} />}
          label={t("Feedback")}
          onClick={handleFeedbackClick}
        />
        <SidebarUpdatePill />
      </SidebarMenu>
    </SidebarFooter>
  );
});
