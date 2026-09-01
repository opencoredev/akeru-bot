import type { McpServer, ProviderAccessStatus } from "@t3tools/contracts";
import { ArrowUpRightIcon, ChevronLeftIcon } from "lucide-react";
import type { PluginDirectoryDefinition, PluginSkill } from "../../../../../plugins";
import { Button } from "../ui/button";
import { DialogHeader, DialogPanel, DialogTitle } from "../ui/dialog";
import { PluginLogoImage } from "./PluginsCatalog";
import {
  pluginBlocker,
  pluginConnectionLabel,
  pluginExecutionLabel,
  pluginPrimaryAction,
} from "./pluginPresentation";

interface PluginDetailsContentProps {
  readonly plugin: PluginDirectoryDefinition;
  readonly server: McpServer | undefined;
  readonly accessStatus?: ProviderAccessStatus;
  readonly activeDependentBotNames: readonly string[];
  readonly pending: boolean;
  readonly onToggle: (enabled: boolean) => void;
  readonly onRemove: () => void;
  readonly onViewDocumentation: () => void;
  readonly onViewSource: () => void;
  readonly onOpenSkill: (skill: PluginSkill) => void;
}

function transportLabel(plugin: PluginDirectoryDefinition): string {
  if (plugin.kind === "mcp-url") return "Remote URL";
  if (plugin.kind === "mcp-stdio") return "Local command";
  return "Unavailable";
}

export function PluginDetailsContent({
  plugin,
  server,
  accessStatus,
  activeDependentBotNames,
  pending,
  onToggle,
  onRemove,
  onViewDocumentation,
  onViewSource,
  onOpenSkill,
}: PluginDetailsContentProps) {
  const action = pluginPrimaryAction(plugin, server);
  const blocker = pluginBlocker(plugin);
  return (
    <DialogPanel className="px-6 pt-6! pb-6 sm:px-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <section className="rounded-2xl border bg-card/50 p-5">
          <div className="flex items-start gap-4">
            <PluginLogoImage className="size-14 rounded-xl" plugin={plugin} />
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate text-lg font-semibold">{plugin.title}</h2>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  {plugin.category}
                </span>
              </div>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                {plugin.description}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">By {plugin.publisher.name}</p>
            </div>
            <div className="flex shrink-0 gap-2">
              {server ? (
                <Button
                  aria-label={`Remove ${plugin.title}`}
                  className="h-8 rounded-full px-3 text-xs"
                  size="sm"
                  variant="ghost-muted"
                  disabled={pending}
                  onClick={onRemove}
                >
                  Remove
                </Button>
              ) : null}
              <Button
                aria-label={`${action.label} ${plugin.title}`}
                className="h-8 min-w-16 rounded-full px-3 text-xs"
                size="sm"
                variant={server?.enabled ? "secondary" : "default"}
                disabled={pending || action.enable === null}
                title={action.blocker}
                onClick={() => action.enable !== null && onToggle(action.enable)}
              >
                {action.label}
              </Button>
            </div>
          </div>
          {blocker ? (
            <p className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive-foreground">
              {blocker}
            </p>
          ) : null}
          <div className="mt-4 flex items-center gap-1 border-t pt-3">
            <Button size="sm" variant="ghost-muted" onClick={onViewDocumentation}>
              Documentation
              <ArrowUpRightIcon className="size-3.5" />
            </Button>
            <Button size="sm" variant="ghost-muted" onClick={onViewSource}>
              Source
              <ArrowUpRightIcon className="size-3.5" />
            </Button>
          </div>
        </section>

        <section aria-labelledby="plugin-connection-title">
          <h3
            className="mb-2 px-1 text-xs font-medium text-muted-foreground"
            id="plugin-connection-title"
          >
            Connection
          </h3>
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border text-sm sm:grid-cols-3">
            {[
              ["Authentication", pluginConnectionLabel(plugin)],
              ["Execution", pluginExecutionLabel(plugin)],
              ["Transport", transportLabel(plugin)],
              ["Status", server ? (server.enabled ? "Enabled" : "Disabled") : "Not installed"],
              [
                "Health",
                accessStatus
                  ? `${accessStatus.health.charAt(0).toUpperCase()}${accessStatus.health.slice(1).replaceAll("-", " ")}`
                  : "Not checked",
              ],
              ...(accessStatus?.repairAction ? [["Repair", accessStatus.repairAction]] : []),
              ["Platforms", plugin.platforms.join(", ")],
              ["License", plugin.license],
            ].map(([label, value]) => (
              <div className="bg-background px-4 py-3" key={label}>
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="mt-1 font-medium">{value}</dd>
              </div>
            ))}
          </dl>
          {plugin.connection.type === "brokered" ? (
            <p className="mt-2 px-1 text-xs text-muted-foreground">
              Brokered by {plugin.connection.broker.name}
            </p>
          ) : null}
        </section>

        <section aria-labelledby="plugin-dependents-title">
          <h3
            className="mb-2 px-1 text-xs font-medium text-muted-foreground"
            id="plugin-dependents-title"
          >
            Dependents
          </h3>
          <dl className="overflow-hidden rounded-xl border bg-muted/35 text-sm">
            <div className="flex items-center justify-between gap-4 border-b px-4 py-3">
              <dt className="text-muted-foreground">Active bots</dt>
              <dd className="text-end font-medium">
                {activeDependentBotNames.length > 0 ? activeDependentBotNames.join(", ") : "None"}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4 px-4 py-3">
              <dt className="text-muted-foreground">Routines</dt>
              <dd className="font-medium">Unavailable until routines ship</dd>
            </div>
          </dl>
        </section>

        <section aria-labelledby="plugin-setup-title">
          <h3
            className="mb-2 px-1 text-xs font-medium text-muted-foreground"
            id="plugin-setup-title"
          >
            Setup
          </h3>
          <div className="space-y-2 rounded-xl border bg-muted/35 px-4 py-3.5 text-sm">
            {plugin.requiredCredentials.length > 0 ? (
              <p>Keys: {plugin.requiredCredentials.join(", ")}</p>
            ) : null}
            {plugin.setup.map((step) => (
              <p className="text-muted-foreground" key={step}>
                {step}
              </p>
            ))}
          </div>
        </section>

        <section aria-labelledby="plugin-permissions-title">
          <div className="mb-2 flex items-center justify-between px-1">
            <h3 className="text-xs font-medium text-muted-foreground" id="plugin-permissions-title">
              Permissions
            </h3>
            <span className="text-[11px] text-muted-foreground">
              Approvals: {plugin.approvals.length > 0 ? plugin.approvals.join(", ") : "None"}
            </span>
          </div>
          <div className="overflow-hidden rounded-xl border bg-muted/35">
            {plugin.permissions.map((permission) => (
              <div className="border-b px-4 py-3 last:border-b-0" key={permission.id}>
                <div className="flex items-start justify-between gap-4">
                  <p className="text-sm">{permission.description}</p>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {permission.approval === "read" ? "Read" : permission.approval}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>

        {plugin.skills?.length ? (
          <section aria-labelledby="plugin-skills-title">
            <div className="mb-2 flex items-center justify-between px-1">
              <h3 className="text-xs font-medium text-muted-foreground" id="plugin-skills-title">
                Skills
              </h3>
              <span className="text-[11px] text-muted-foreground">Installed separately</span>
            </div>
            <div className="overflow-hidden rounded-xl border bg-muted/35">
              {plugin.skills.map((skill) => (
                <button
                  className="group flex w-full cursor-pointer items-center justify-between gap-4 border-b px-4 py-3.5 text-start outline-hidden transition-colors last:border-b-0 hover:bg-muted/55 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  key={skill.url}
                  type="button"
                  onClick={() => onOpenSkill(skill)}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{skill.title}</p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {skill.description}
                    </p>
                  </div>
                  <ArrowUpRightIcon className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
                </button>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </DialogPanel>
  );
}

export function PluginDetails({
  plugin,
  server,
  accessStatus,
  activeDependentBotNames,
  pending,
  onBack,
  onToggle,
  onRemove,
  onViewDocumentation,
  onViewSource,
  onOpenSkill,
}: PluginDetailsContentProps & { readonly onBack: () => void }) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" data-plugin-details="">
      <DialogHeader className="border-b px-5 py-4">
        <div className="flex items-center gap-2 pe-8">
          <Button aria-label="Back to plugins" size="icon-sm" variant="ghost" onClick={onBack}>
            <ChevronLeftIcon className="size-4" />
          </Button>
          <DialogTitle className="text-base">Plugin details</DialogTitle>
        </div>
      </DialogHeader>
      <PluginDetailsContent
        plugin={plugin}
        server={server}
        {...(accessStatus ? { accessStatus } : {})}
        activeDependentBotNames={activeDependentBotNames}
        pending={pending}
        onToggle={onToggle}
        onRemove={onRemove}
        onViewDocumentation={onViewDocumentation}
        onViewSource={onViewSource}
        onOpenSkill={onOpenSkill}
      />
    </div>
  );
}
