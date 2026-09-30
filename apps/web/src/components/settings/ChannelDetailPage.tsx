import {
  canChangeChannelProject,
  channelReconnectProject,
  channelBindingNeedsProject,
  channelPickerProjectId,
  channelRepairAction,
} from "@t3tools/client-runtime/channel-presentation";
import {
  BotId,
  type ChannelConnectionProfile,
  type ChannelProvider,
  type ProjectId,
} from "@t3tools/contracts";
import { EllipsisIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { useI18n } from "../../i18n";
import { useSettingsEnvironmentId } from "../../settingsDialogStore";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  ChannelAccessRow,
  channelState,
  channelTestInstructions,
  connectionAssignment,
  providerLabel,
  UNASSIGNED,
  useChannelSettings,
} from "./BotChannelsSettings";
import { ChannelProjectSelect } from "./ChannelProjectSelect";
import { type ChannelReplacement, ChannelSetupDialog } from "./ChannelSetupDialog";
import {
  ChannelRepairButton,
  ChannelStatusBadge,
  ChannelStatusNotice,
  channelWebhookUrl,
} from "./ChannelStatus";
import { channelProviderMeta } from "./channelProviderMeta";
import { SettingsDetailHeader, SettingsMessageRow } from "./settingsDetailLayout";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

type ChannelSettings = ReturnType<typeof useChannelSettings>;

/** Setup, bot assignment, project, and repair for one channel kind, such as Telegram. */
export function ChannelDetailPage({ provider }: { readonly provider: ChannelProvider }) {
  const { t, plural } = useI18n();
  const environmentId = useSettingsEnvironmentId();
  const settings = useChannelSettings(environmentId);
  const [setupOpen, setSetupOpen] = useState(false);
  const [replacing, setReplacing] = useState<ChannelReplacement | null>(null);
  const meta = channelProviderMeta(provider);
  const allowed = settings.access === "allowed";
  const connections = settings.connections.filter((connection) => connection.provider === provider);
  const state = allowed
    ? channelState(provider, settings.connections, settings.bots, settings.liveProjects, t, plural)
    : { tone: "neutral" as const, label: t("Unavailable") };
  const openSetup = (next: ChannelReplacement | null) => {
    setReplacing(next);
    setSetupOpen(true);
  };

  return (
    <SettingsPageContainer className="gap-10">
      <SettingsDetailHeader
        back={{ section: "channels", label: t("Channels") }}
        icon={meta.icon}
        title={meta.label}
        tone={state.tone}
        statusLabel={state.label}
        description={meta.tagline}
      />
      <SettingsSection
        id="channel-connections"
        title={t("Connections")}
        headerAction={
          allowed && connections.length > 0 ? (
            <Button size="xs" variant="outline" onClick={() => openSetup(null)}>
              <PlusIcon className="size-3.5" />
              {t("Add connection")}
            </Button>
          ) : null
        }
      >
        {!allowed ? (
          <ChannelAccessRow access={settings.access} />
        ) : connections.length === 0 ? (
          <SettingsMessageRow
            action={
              <Button size="xs" onClick={() => openSetup(null)}>
                {t("Set up {name}", { name: meta.label })}
              </Button>
            }
          >
            {t("No {name} connections yet.", { name: meta.label })}
          </SettingsMessageRow>
        ) : (
          connections.map((connection) => (
            <ChannelConnectionRow
              key={connection.id}
              connection={connection}
              settings={settings}
              onReplaceCredentials={openSetup}
            />
          ))
        )}
      </SettingsSection>
      {environmentId !== null && allowed ? (
        <ChannelSetupDialog
          // Remount per target so a credentials update never inherits another dialog's fields.
          key={replacing?.connectionId ?? "new"}
          environmentId={environmentId}
          provider={provider}
          open={setupOpen}
          onOpenChange={setSetupOpen}
          bots={settings.activeBots}
          replacing={replacing}
          onSaved={settings.awaitSavedConnection}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

/** One connection: its health, bot, project, repair, and management actions. */
export function ChannelConnectionRow({
  connection,
  settings,
  onReplaceCredentials,
}: {
  readonly connection: ChannelConnectionProfile;
  readonly settings: ChannelSettings;
  readonly onReplaceCredentials: (replacement: ChannelReplacement) => void;
}) {
  const { t } = useI18n();
  const [pickedProjectId, setPickedProjectId] = useState<ProjectId | null>(null);
  const { bot, binding } = connectionAssignment(connection.id, settings.bots);
  const { liveProjects } = settings;
  const externalIdentity = binding?.externalIdentity ?? connection.externalIdentity;
  const connectionBusy = settings.busyConnectionId === connection.id;
  const locked = settings.busy || connectionBusy;
  const needsProject = binding ? channelBindingNeedsProject(binding, liveProjects) : false;
  const projectId = channelPickerProjectId({
    selected: pickedProjectId,
    binding,
    hint: settings.projectHint(bot?.id ?? null),
    liveProjects,
  });
  const canMove =
    bot !== undefined &&
    binding !== undefined &&
    canChangeChannelProject(binding, projectId, liveProjects);
  const repairAction = bot && binding ? channelRepairAction(binding, liveProjects) : "none";
  const showProviderLink = connection.managementUrl && repairAction !== "check-delivery";
  const canDisconnect = bot !== undefined && binding?.status === "connected";

  return (
    <div data-settings-row="" className="space-y-3 rounded-xl px-3 py-3 sm:px-4">
      <div className="flex min-h-8 items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2.5">
            <h3 className="truncate text-sm font-medium text-foreground">{connection.name}</h3>
            <ChannelStatusBadge
              binding={binding}
              ownerName={bot?.name}
              needsProject={needsProject}
            />
          </div>
          <p className="truncate text-[13px] text-muted-foreground/80">
            {providerLabel(connection.provider)}
            {externalIdentity ? ` · ${externalIdentity}` : ""}
          </p>
        </div>
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-7 shrink-0 text-muted-foreground hover:text-foreground sm:size-7"
                aria-label={t("Actions for {name}", { name: connection.name })}
              />
            }
          >
            <EllipsisIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-44">
            {showProviderLink ? (
              <MenuItem
                render={<a href={connection.managementUrl} target="_blank" rel="noreferrer" />}
              >
                {t("Open provider")}
              </MenuItem>
            ) : null}
            {canDisconnect ? (
              <MenuItem
                disabled={locked}
                onClick={() => void settings.disconnectConnection(connection, bot.id)}
              >
                {t("Disconnect")}
              </MenuItem>
            ) : null}
            {showProviderLink || canDisconnect ? <MenuSeparator /> : null}
            <MenuItem
              variant="destructive"
              disabled={locked || bot !== undefined}
              onClick={() => void settings.removeConnection(connection)}
            >
              {t("Delete")}
            </MenuItem>
            {bot ? (
              <p className="max-w-56 px-2 pt-1 pb-1.5 text-xs text-muted-foreground">
                {t("Choose No bot to delete this connection.")}
              </p>
            ) : null}
          </MenuPopup>
        </Menu>
      </div>
      <ChannelStatusNotice
        binding={binding}
        needsProject={needsProject}
        webhookUrl={channelWebhookUrl(connection)}
      />
      <div className="flex min-w-0 flex-wrap items-end gap-x-3 gap-y-2">
        <div className="flex w-full min-w-0 flex-col gap-1 sm:w-auto">
          <span className="text-xs font-medium text-muted-foreground">{t("Bot that answers")}</span>
          <Select
            value={bot?.id ?? UNASSIGNED}
            onValueChange={(next) => {
              if (!next) return;
              if (next === UNASSIGNED) {
                void settings.updateAssignment(connection, next, null);
                return;
              }
              const selectedProject = liveProjects.some((project) => project.id === pickedProjectId)
                ? pickedProjectId
                : null;
              const destinationProject = selectedProject ?? settings.projectHint(BotId.make(next));
              if (!destinationProject) return;
              void settings.updateAssignment(connection, next, destinationProject);
            }}
          >
            <SelectTrigger
              size="xs"
              aria-label={t("Assign {name}", { name: connection.name })}
              className="w-full sm:w-48"
              // No bot needs no project, so an assigned channel can always be unassigned.
              disabled={connectionBusy || (!bot && projectId === null)}
            >
              <SelectValue>{bot?.name ?? t("Choose a bot")}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value={UNASSIGNED}>{t("No bot")}</SelectItem>
              {bot?.archivedAt ? (
                <SelectItem value={bot.id}>{t("{name} (archived)", { name: bot.name })}</SelectItem>
              ) : null}
              {settings.activeBots.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id} disabled={projectId === null}>
                  {candidate.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <ChannelProjectSelect
          projects={liveProjects}
          value={projectId}
          onChange={setPickedProjectId}
          label={t("Project for {name}", { name: connection.name })}
          disabled={connectionBusy}
          size="xs"
        />
        {bot && binding ? (
          <ChannelRepairButton
            size="xs"
            action={repairAction}
            status={binding.status}
            disabled={locked || (repairAction === "choose-project" && !canMove)}
            managementUrl={connection.managementUrl}
            onRepair={(action) => {
              if (action === "choose-project") {
                if (canMove) void settings.moveToProject(connection, bot.id, projectId);
              } else if (action === "update-credentials") {
                onReplaceCredentials({
                  connectionId: connection.id,
                  name: connection.name,
                  botId: bot.id,
                  projectId: binding.projectId,
                  disconnected: binding.status === "disconnected",
                });
              } else {
                // A disconnected channel starts in the project the picker shows.
                const target = channelReconnectProject(binding, projectId, liveProjects);
                if (target) void settings.moveToProject(connection, bot.id, target);
                else void settings.reconnectConnection(connection, bot.id);
              }
            }}
          />
        ) : null}
        {canMove && repairAction !== "choose-project" ? (
          <Button
            size="xs"
            variant="outline"
            disabled={locked}
            onClick={() => void settings.moveToProject(connection, bot.id, projectId)}
          >
            {t("Move to this project")}
          </Button>
        ) : null}
      </div>
      {bot ? (
        <p className="text-[13px] text-muted-foreground/80">
          {channelTestInstructions(connection.provider, bot.name, t)}
        </p>
      ) : null}
    </div>
  );
}
