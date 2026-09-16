import { useAtomValue } from "@effect/atom-react";
import { BotId, type EnvironmentId } from "@t3tools/contracts";
import { Brain02Icon, Edit02Icon, Link02Icon, WrenchIcon } from "@hugeicons/core-free-icons";
import { useCanGoBack, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

import { isElectron } from "../../env";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { botEnvironment } from "../../state/bots";
import { environmentMcpServersAtom } from "../../state/mcpServers";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { SidebarInset } from "../ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { AppIcon } from "../ui/app-icon";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { TraitsPicker } from "../chat/TraitsPicker";
import { AvatarPickerDialog } from "./AvatarPickerDialog";
import { BotAvatarView } from "./BotAvatarView";
import { BotChannelsSheet } from "./BotChannelsSheet";
import { BotMemorySheet } from "./BotMemorySheet";
import { BotModelPicker } from "./BotModelPicker";
import { BotPersonalityToneField } from "./BotPersonalityToneField";
import { BotToolsSheet, buildBotToolItems } from "./BotToolsSheet";
import { BotUsageSection } from "./BotUsageSection";
import { BOT_SANDBOX_OPTIONS, botSandboxLabel } from "./botSandbox";
import { useRosterStore } from "./rosterStore";
import { useBotThreadRef } from "./useBotThreadRef";
import { useBotProfileDraft, type BotProfileUpdate } from "./useBotProfileDraft";
import type { Bot } from "./types";

const NO_ENVIRONMENT = "" as EnvironmentId;

/**
 * The full settings surface for one bot. Everything a bot owns lives here, in
 * the main content area, so the in-chat panel stays a quick-edit companion
 * rather than the only place these controls fit.
 */
export function BotSettingsPage({ botId }: { readonly botId: string }) {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const environmentId = usePrimaryEnvironmentId();
  const updateBot = useAtomCommand(botEnvironment.update, { reportFailure: false });
  const bot = useRosterStore((state) =>
    state.bots.find((candidate) => candidate.id === botId && candidate.archivedAt === null),
  );

  const navigateBackWithinApp = useCallback(() => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, navigate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key !== "Escape") return;
      const activeElement = document.activeElement;
      // Let a focused field take Escape first; a second press leaves the page.
      if (activeElement instanceof HTMLElement && activeElement !== document.body) {
        activeElement.blur();
        return;
      }
      event.preventDefault();
      navigateBackWithinApp();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigateBackWithinApp]);

  const onSaveBot = useCallback(
    async (input: BotProfileUpdate) => {
      if (!environmentId || !bot) return false;
      const result = await updateBot({
        environmentId,
        input: { botId: BotId.make(bot.id), ...input },
      });
      if (result._tag === "Failure") {
        toastManager.add({ type: "error", title: "Could not save bot settings" });
        return false;
      }
      toastManager.add({ type: "success", title: "Bot settings saved" });
      return true;
    },
    [bot, environmentId, updateBot],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border/70">
          <WorkspaceBreadcrumb ariaLabel="Bot settings breadcrumb">
            <WorkspaceBreadcrumbItem>Bots</WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current>
              {bot ? bot.name : "Unavailable bot"}
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        {bot ? (
          <BotSettingsForm key={bot.id} bot={bot} onSave={onSaveBot} />
        ) : (
          <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
            This bot is no longer available.
          </div>
        )}
      </div>
    </SidebarInset>
  );
}

function BotSettingsForm({
  bot,
  onSave,
}: {
  readonly bot: Bot;
  readonly onSave: (input: BotProfileUpdate) => Promise<boolean>;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const mcpServers = useAtomValue(environmentMcpServersAtom(environmentId ?? NO_ENVIRONMENT));
  const threadRef = useBotThreadRef(bot.id);
  const draft = useBotProfileDraft(bot, onSave);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [channelsOpen, setChannelsOpen] = useState(false);

  // Memoized because this walks the plugin catalog and does not depend on the form draft.
  const tools = useMemo(() => buildBotToolItems(mcpServers), [mcpServers]);
  const enabledToolCount = tools.filter(
    (tool) => tool.workspaceEnabled && !draft.disabledMcpServerIds.includes(tool.id),
  ).length;
  const assignedChannels = (bot.channelBindings ?? []).filter(
    (binding) => binding.connectionId || binding.projectId || binding.status !== "disconnected",
  );
  const connectedChannelCount = assignedChannels.filter(
    (binding) => binding.status === "connected",
  ).length;

  return (
    <>
      <SettingsPageContainer>
        <SettingsSection title="Bot">
          <SettingsRow
            title="Avatar"
            description="Shown in the roster, the chat header, and anywhere this bot speaks."
            control={
              <button
                type="button"
                aria-label="Change bot avatar"
                onClick={() => setAvatarOpen(true)}
                className="group relative rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <BotAvatarView
                  avatar={bot.avatar}
                  name={draft.name || bot.name}
                  className="size-14"
                />
                <span className="absolute -bottom-1 -right-1 flex size-6 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition-colors group-hover:text-foreground">
                  <AppIcon className="size-3" icon={Edit02Icon} />
                </span>
              </button>
            }
          />

          <SettingsRow
            title="Name"
            description="What you call this bot in chats and mentions."
            control={
              <Input
                className="w-full sm:w-64"
                aria-label="Bot name"
                value={draft.name}
                onChange={(event) => {
                  draft.setName(event.currentTarget.value);
                  draft.markChanged();
                }}
              />
            }
          />

          <SettingsRow
            title="Label"
            description="An optional role, such as research, marketing, or admin."
            control={
              <Input
                className="w-full sm:w-64"
                aria-label="Bot label"
                value={draft.label}
                placeholder="Research, marketing, admin"
                onChange={(event) => {
                  draft.setLabel(event.currentTarget.value);
                  draft.markChanged();
                }}
              />
            }
          />

          <SettingsRow
            title="Description"
            description="A note to yourself about what this bot is for. Searchable from the roster."
          >
            <div className="mt-3 max-w-2xl pb-3.5">
              <Textarea
                aria-label="Bot description"
                value={draft.description}
                placeholder="What this bot is for"
                rows={4}
                className="min-h-24 resize-none"
                onChange={(event) => {
                  draft.setDescription(event.currentTarget.value);
                  draft.markChanged();
                }}
              />
            </div>
          </SettingsRow>
        </SettingsSection>

        <SettingsSection title="Voice and personality">
          <SettingsRow
            id="personality"
            title="Personality"
            description="Choose how this bot usually sounds. It is a baseline, not a costume. The bot still adapts to you and to the task, so serious work stays serious in every mode."
          >
            <div className="mt-3 max-w-2xl pb-3.5">
              <BotPersonalityToneField
                bot={bot}
                tone={draft.personalityTone}
                onToneChange={(tone) => {
                  draft.setPersonalityTone(tone);
                  draft.markChanged();
                }}
              />
            </div>
          </SettingsRow>

          <SettingsRow
            title="Voice calls"
            description="Let this bot take subscription voice calls. Voice must also be enabled in Settings."
            control={
              <Switch
                checked={draft.voiceEnabled}
                onCheckedChange={(checked) => {
                  draft.setVoiceEnabled(Boolean(checked));
                  draft.markChanged();
                }}
                aria-label={`${draft.voiceEnabled ? "Disable" : "Enable"} voice calls for ${bot.name}`}
              />
            }
          />
        </SettingsSection>

        <SettingsSection title="Model">
          <SettingsRow
            title="Model"
            description="The provider and model this bot runs on."
            control={
              draft.activeEntry && draft.model ? (
                <BotModelPicker
                  activeInstanceId={draft.activeEntry.instanceId}
                  model={draft.model}
                  instanceEntries={draft.instanceEntries}
                  modelOptionsByInstance={draft.modelOptionsByInstance}
                  onChange={draft.selectModel}
                />
              ) : (
                <span className="text-sm text-muted-foreground">Connect a provider</span>
              )
            }
          />

          {draft.showModelOptions && draft.activeEntry ? (
            <SettingsRow
              title="Reasoning"
              description="How much thinking this bot spends before it answers."
              control={
                <TraitsPicker
                  provider={draft.activeEntry.driverKind}
                  instanceId={draft.activeEntry.instanceId}
                  models={draft.activeEntry.models}
                  model={draft.model}
                  prompt=""
                  onPromptChange={() => {}}
                  modelOptions={draft.modelOptions}
                  allowPromptInjectedEffort={false}
                  planModeEnabled={draft.settings.planModeEnabled}
                  onModelOptionsChange={draft.selectModelOptions}
                />
              }
            />
          ) : null}

          {draft.resolvedUsageCap.available ? (
            <SettingsRow
              title="Token hard stop"
              description="Stop this bot once it has spent this many tokens. Leave empty for no limit."
              control={
                <Input
                  className="w-full sm:w-40"
                  aria-label="Token hard stop"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  value={draft.usageCap}
                  placeholder="No limit"
                  onChange={(event) => {
                    draft.setUsageCap(event.currentTarget.value);
                    draft.markChanged();
                  }}
                />
              }
            />
          ) : (
            <SettingsRow
              title="Token hard stop"
              description="This provider reports occupancy rather than tokens, so a token limit does not apply."
              control={<span className="text-sm text-muted-foreground">Unavailable</span>}
            />
          )}

          <SettingsRow title="Usage" description="What this bot has spent so far.">
            <div className="mt-3 max-w-2xl pb-3.5">
              <BotUsageSection environmentId={environmentId} botId={bot.id} />
            </div>
          </SettingsRow>
        </SettingsSection>

        <SettingsSection title="Workspace">
          <SettingsRow
            title="Sandbox"
            description="Where this bot runs commands and edits files."
            control={
              <Select
                value={draft.sandbox}
                onValueChange={(value) => {
                  if (value === null) return;
                  if (!BOT_SANDBOX_OPTIONS.some((option) => option.value === value)) return;
                  draft.setSandbox(value as typeof draft.sandbox);
                  draft.markChanged();
                }}
              >
                <SelectTrigger className="w-full sm:w-48" aria-label="Sandbox provider">
                  <SelectValue>{botSandboxLabel(draft.sandbox)}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {BOT_SANDBOX_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />

          <SettingsRow
            title="Tools"
            description="Which workspace tools this bot may reach."
            control={
              <Button
                variant="outline"
                size="xs"
                type="button"
                aria-label="Manage bot tools"
                aria-expanded={toolsOpen}
                onClick={() => setToolsOpen(true)}
              >
                <AppIcon className="size-3.5" icon={WrenchIcon} />
                {tools.length === 0
                  ? "No workspace tools"
                  : `${enabledToolCount} of ${tools.length} enabled`}
              </Button>
            }
          />

          <SettingsRow
            title="Memory"
            description="Facts this bot keeps between chats."
            control={
              <Button
                variant="outline"
                size="xs"
                type="button"
                aria-label="Manage bot memory"
                disabled={!threadRef}
                onClick={() => setMemoryOpen(true)}
              >
                <AppIcon className="size-3.5" icon={Brain02Icon} />
                Facts and history
              </Button>
            }
          />

          <SettingsRow
            title="Channels"
            description="Where this bot answers outside Akeru Bot."
            control={
              <Button
                variant="outline"
                size="xs"
                type="button"
                aria-label="Manage bot channels"
                aria-expanded={channelsOpen}
                onClick={() => setChannelsOpen(true)}
              >
                <AppIcon className="size-3.5" icon={Link02Icon} />
                {assignedChannels.length === 0
                  ? "No channels"
                  : `${connectedChannelCount} of ${assignedChannels.length} connected`}
              </Button>
            }
          />
        </SettingsSection>
      </SettingsPageContainer>

      <div
        className="flex shrink-0 items-center justify-end gap-3 border-t border-border/70 px-5 py-3 sm:px-6"
        data-testid="bot-settings-save-bar"
      >
        <span aria-live="polite" className="mr-auto text-xs text-muted-foreground">
          {draft.saved ? (
            <span className="text-success">Saved</span>
          ) : draft.dirty ? (
            "Unsaved changes"
          ) : null}
        </span>
        <Button size="sm" disabled={!draft.canSave || draft.saving} onClick={draft.save}>
          {draft.saving ? "Saving" : "Save"}
        </Button>
      </div>

      <AvatarPickerDialog bot={bot} open={avatarOpen} onOpenChange={setAvatarOpen} />
      <BotToolsSheet
        open={toolsOpen}
        onOpenChange={setToolsOpen}
        servers={mcpServers}
        disabledIds={draft.disabledMcpServerIds}
        onDisabledIdsChange={(ids) => {
          draft.setDisabledMcpServerIds(ids);
          draft.markChanged();
        }}
      />
      <BotMemorySheet open={memoryOpen} onOpenChange={setMemoryOpen} threadRef={threadRef} />
      <BotChannelsSheet bot={bot} open={channelsOpen} onOpenChange={setChannelsOpen} />
    </>
  );
}
