import type { ChannelConnectionProfile, ChannelProvider } from "@t3tools/contracts";
import { EllipsisIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { useSettingsEnvironmentId } from "../../settingsDialogStore";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  bindingNeedsReconnect,
  ChannelAccessRow,
  channelState,
  channelTestInstructions,
  connectionAssignment,
  connectionState,
  providerLabel,
  UNASSIGNED,
  useChannelSettings,
} from "./BotChannelsSettings";
import { ChannelSetupDialog } from "./ChannelSetupDialog";
import { channelProviderMeta } from "./channelProviderMeta";
import { SettingsDetailHeader, SettingsMessageRow, SettingsStatus } from "./settingsDetailLayout";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

type ChannelSettings = ReturnType<typeof useChannelSettings>;

/** Setup and bot assignment for one channel kind, such as Telegram or iMessage. */
export function ChannelDetailPage({ provider }: { readonly provider: ChannelProvider }) {
  const environmentId = useSettingsEnvironmentId();
  const settings = useChannelSettings(environmentId);
  const [setupOpen, setSetupOpen] = useState(false);
  const meta = channelProviderMeta(provider);
  const allowed = settings.access === "allowed";
  const connections = settings.connections.filter((connection) => connection.provider === provider);
  const state = allowed
    ? channelState(provider, settings.connections, settings.bots)
    : { tone: "neutral" as const, label: "Unavailable" };

  return (
    <SettingsPageContainer className="gap-10">
      <SettingsDetailHeader
        back={{ section: "channels", label: "Channels" }}
        icon={meta.icon}
        title={meta.label}
        tone={state.tone}
        statusLabel={state.label}
        description={meta.tagline}
      />
      <SettingsSection
        id="channel-connections"
        title="Connections"
        headerAction={
          allowed && connections.length > 0 ? (
            <Button size="xs" variant="outline" onClick={() => setSetupOpen(true)}>
              <PlusIcon className="size-3.5" />
              Add connection
            </Button>
          ) : null
        }
      >
        {!allowed ? (
          <ChannelAccessRow access={settings.access} />
        ) : connections.length === 0 ? (
          <SettingsMessageRow
            action={
              <Button size="xs" onClick={() => setSetupOpen(true)}>
                Set up {meta.label}
              </Button>
            }
          >
            No {meta.label} connections yet.
          </SettingsMessageRow>
        ) : (
          connections.map((connection) => (
            <ChannelConnectionRow key={connection.id} connection={connection} settings={settings} />
          ))
        )}
      </SettingsSection>
      {environmentId !== null && allowed ? (
        <ChannelSetupDialog
          environmentId={environmentId}
          provider={provider}
          open={setupOpen}
          onOpenChange={setSetupOpen}
          bots={settings.activeBots}
          onSaved={settings.awaitSavedConnection}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

function ChannelConnectionRow({
  connection,
  settings,
}: {
  readonly connection: ChannelConnectionProfile;
  readonly settings: ChannelSettings;
}) {
  const { bot, binding } = connectionAssignment(connection.id, settings.bots);
  const state = connectionState(bot, binding);
  const externalIdentity = binding?.externalIdentity ?? connection.externalIdentity;
  const locked = settings.busy || settings.busyConnectionId === connection.id;
  const canDisconnect = bot !== undefined && binding?.status === "connected";

  return (
    <div data-settings-row="" className="space-y-2 rounded-xl px-3 py-3 sm:px-4">
      <div className="flex min-h-8 flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2.5">
            <h3 className="truncate text-sm font-medium text-foreground">{connection.name}</h3>
            <SettingsStatus tone={state.tone} label={state.label} />
          </div>
          <p className="truncate text-[13px] text-muted-foreground/80">
            {providerLabel(connection.provider)}
            {externalIdentity ? ` · ${externalIdentity}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs text-muted-foreground">Bot that answers</span>
          <Select
            value={bot?.id ?? UNASSIGNED}
            onValueChange={(next) => next && void settings.updateAssignment(connection, next)}
          >
            <SelectTrigger
              size="xs"
              aria-label={`Assign ${connection.name}`}
              className="w-40"
              disabled={settings.busyConnectionId === connection.id}
            >
              <SelectValue>{bot?.name ?? "Choose a bot"}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value={UNASSIGNED}>No bot</SelectItem>
              {bot?.archivedAt ? (
                <SelectItem value={bot.id}>{bot.name} (archived)</SelectItem>
              ) : null}
              {settings.activeBots.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {bot && bindingNeedsReconnect(binding) ? (
            <Button
              size="xs"
              variant="outline"
              disabled={locked}
              onClick={() => void settings.reconnectConnection(connection, bot.id)}
            >
              Reconnect
            </Button>
          ) : null}
          <Menu>
            <MenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-7 text-muted-foreground hover:text-foreground sm:size-7"
                  aria-label={`Actions for ${connection.name}`}
                />
              }
            >
              <EllipsisIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end" className="min-w-40">
              {connection.managementUrl ? (
                <MenuItem
                  render={<a href={connection.managementUrl} target="_blank" rel="noreferrer" />}
                >
                  Open provider
                </MenuItem>
              ) : null}
              {canDisconnect ? (
                <MenuItem
                  disabled={locked}
                  onClick={() => void settings.disconnectConnection(connection, bot.id)}
                >
                  Disconnect
                </MenuItem>
              ) : null}
              <MenuItem
                variant="destructive"
                disabled={locked || bot !== undefined}
                onClick={() => void settings.removeConnection(connection)}
              >
                {bot ? "Unassign to delete" : "Delete"}
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </div>
      {binding?.lastError ? (
        <p role="status" className="text-xs break-words text-warning">
          {binding.lastError}
        </p>
      ) : null}
      {bot ? (
        <p className="text-[13px] text-muted-foreground/80">
          {channelTestInstructions(connection.provider, bot.name)}
        </p>
      ) : null}
    </div>
  );
}
