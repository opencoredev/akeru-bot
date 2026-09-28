import { useAtomValue } from "@effect/atom-react";
import {
  BotId,
  IMAGE_PROVIDER_IDS,
  type EnvironmentId,
  type ImageProviderId,
} from "@t3tools/contracts";
import {
  botImageProviderOptionLabel,
  globalDefaultOptionLabel,
} from "@t3tools/client-runtime/image-generation";
import { driverSupportsDelegation } from "@t3tools/shared/delegationProviders";
import { Brain02Icon, Edit02Icon, Link02Icon } from "@hugeicons/core-free-icons";
import { useBlocker, useCanGoBack, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { isElectron } from "../../env";
import { useI18n } from "../../i18n";
import { requestConfirmDialog } from "../../confirmDialog";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { openSettings } from "../../settingsDialogStore";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { botEnvironment } from "../../state/bots";
import { environmentMcpServersAtom } from "../../state/mcpServers";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
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
import { ProviderUnavailableNotice } from "../chat/ProviderUnavailableNotice";
import { TraitsPicker } from "../chat/TraitsPicker";
import { AvatarPickerDialog } from "./AvatarPickerDialog";
import { BotAvatarView } from "./BotAvatarView";
import { BotChannelsSheet } from "./BotChannelsSheet";
import { BotMemorySheet } from "./BotMemorySheet";
import { BotModelPicker } from "./BotModelPicker";
import { BotPersonalityToneField } from "./BotPersonalityToneField";
import { BotToolsSection } from "./BotToolsSection";
import { BotUsageSection } from "./BotUsageSection";
import { BOT_SANDBOX_OPTIONS, botSandboxLabel } from "./botSandbox";
import { useRosterStore } from "./rosterStore";
import { useBotThreadRef } from "./useBotThreadRef";
import {
  BOT_IMAGE_PROVIDER_DEFAULT,
  botImageProviderFromSelectValue,
  useBotProfileDraft,
  type BotProfileUpdate,
} from "./useBotProfileDraft";
import type { Bot } from "./types";

const NO_ENVIRONMENT = "" as EnvironmentId;

/**
 * The full settings surface for one bot. Everything a bot owns lives here, in
 * the main content area, so the in-chat panel stays a quick-edit companion
 * rather than the only place these controls fit.
 */
export function BotSettingsPage({ botId }: { readonly botId: string }) {
  const { t } = useI18n();
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
        toastManager.add({ type: "error", title: t("Could not save bot settings") });
        return false;
      }
      toastManager.add({ type: "success", title: t("Bot settings saved") });
      return true;
    },
    [bot, environmentId, t, updateBot],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border/70">
          <WorkspaceBreadcrumb ariaLabel={t("Bot settings breadcrumb")}>
            <WorkspaceBreadcrumbItem>{t("Bots")}</WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current>
              {bot ? bot.name : t("Unavailable bot")}
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        {bot ? (
          <BotSettingsForm key={bot.id} bot={bot} onSave={onSaveBot} />
        ) : (
          <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
            {t("This bot is no longer available.")}
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
  const { t } = useI18n();
  const environmentId = usePrimaryEnvironmentId();
  const mcpServers = useAtomValue(environmentMcpServersAtom(environmentId ?? NO_ENVIRONMENT));
  const imageSettings = useEnvironmentSettings(
    environmentId ?? NO_ENVIRONMENT,
    (settings) => settings.imageGeneration,
  );
  const imageProviders = useEnvironmentQuery(
    environmentId ? serverEnvironment.imageProviders({ environmentId, input: {} }) : null,
  );
  const imageProviderLabel = (provider: ImageProviderId) =>
    botImageProviderOptionLabel(
      provider,
      imageSettings,
      imageProviders.data?.providers.find((status) => status.provider === provider),
    );
  const threadRef = useBotThreadRef(bot.id);
  const accessQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.subscriptionAuth({ environmentId, input: {} }),
  );
  const draft = useBotProfileDraft(bot, onSave);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [channelsOpen, setChannelsOpen] = useState(false);

  const shouldBlockNavigation = useCallback(async () => {
    if (!draft.dirty) return false;
    const confirmation = requestConfirmDialog(t("Discard unsaved bot settings?"), {
      variant: "destructive",
    });
    if (!confirmation) return true;
    return !(await confirmation);
  }, [draft.dirty, t]);
  useBlocker({
    shouldBlockFn: shouldBlockNavigation,
    enableBeforeUnload: () => draft.dirty,
    disabled: !draft.dirty,
  });

  const assignedChannels = (bot.channelBindings ?? []).filter(
    (binding) => binding.connectionId || binding.projectId || binding.status !== "disconnected",
  );
  const connectedChannelCount = assignedChannels.filter(
    (binding) => binding.status === "connected",
  ).length;

  return (
    <>
      <SettingsPageContainer>
        <div className="flex items-center gap-4 px-3 pb-1 sm:px-4">
          <BotAvatarView avatar={bot.avatar} name={draft.name || bot.name} className="size-14" />
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight">
              {draft.name || bot.name}
            </h1>
            <p className="text-sm text-muted-foreground">Set up how this bot works with you.</p>
          </div>
        </div>
        <nav aria-label="Bot settings sections" className="flex gap-1 overflow-x-auto px-2 sm:px-3">
          {(
            [
              ["identity", "Identity"],
              ["behavior", "Behavior"],
              ["model", "Model & usage"],
              ["workspace", "Workspace"],
              ["tools", "Tools"],
            ] as const
          ).map(([id, label]) => (
            <a
              key={id}
              href={`#${id}`}
              className="shrink-0 rounded-lg px-3 py-2 text-sm text-muted-foreground outline-none hover:bg-secondary/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={(event) => {
                event.preventDefault();
                document.getElementById(id)?.scrollIntoView({ block: "start" });
              }}
            >
              {label}
            </a>
          ))}
        </nav>

        <SettingsSection id="identity" title="Identity">
          <SettingsRow
            title={t("Avatar")}
            description={t("Shown in the roster, the chat header, and anywhere this bot speaks.")}
            control={
              <button
                type="button"
                aria-label={t("Change bot avatar")}
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
            title={t("Name")}
            description={t("What you call this bot in chats and mentions.")}
            control={
              <Input
                className="w-full sm:w-64"
                aria-label={t("Bot name")}
                value={draft.name}
                onChange={(event) => {
                  draft.setName(event.currentTarget.value);
                  draft.markChanged();
                }}
              />
            }
          />

          <SettingsRow
            title={t("Label")}
            description={t("An optional role, such as research, marketing, or admin.")}
            control={
              <Input
                className="w-full sm:w-64"
                aria-label={t("Bot label")}
                value={draft.label}
                placeholder={t("Research, marketing, admin")}
                onChange={(event) => {
                  draft.setLabel(event.currentTarget.value);
                  draft.markChanged();
                }}
              />
            }
          />

          <SettingsRow
            title={t("Description")}
            description={t(
              "A note to yourself about what this bot is for. Searchable from the roster.",
            )}
          >
            <div className="mt-3 max-w-2xl pb-3.5">
              <Textarea
                aria-label={t("Bot description")}
                value={draft.description}
                placeholder={t("What this bot is for")}
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

        <SettingsSection id="behavior" title="Behavior">
          <SettingsRow
            id="personality"
            title={t("Personality")}
            description={t(
              "Choose how this bot usually sounds. It is a baseline, not a costume. The bot still adapts to you and to the task, so serious work stays serious in every mode.",
            )}
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
            title={t("Voice calls")}
            description={t(
              "Let this bot take subscription voice calls. Voice must also be enabled in Settings.",
            )}
            control={
              <Switch
                checked={draft.voiceEnabled}
                onCheckedChange={(checked) => {
                  draft.setVoiceEnabled(Boolean(checked));
                  draft.markChanged();
                }}
                aria-label={
                  draft.voiceEnabled
                    ? t("Disable voice calls for {name}", { name: bot.name })
                    : t("Enable voice calls for {name}", { name: bot.name })
                }
              />
            }
          />
        </SettingsSection>

        <SettingsSection id="model" title="Model & usage">
          <SettingsRow
            title={t("Model")}
            description={t("The provider and model this bot runs on.")}
            control={
              draft.model ? (
                <BotModelPicker
                  activeInstanceId={draft.providerInstanceId}
                  model={draft.model}
                  instanceEntries={draft.instanceEntries}
                  modelOptionsByInstance={draft.modelOptionsByInstance}
                  onChange={draft.selectModel}
                />
              ) : (
                <span className="text-sm text-muted-foreground">{t("No model yet")}</span>
              )
            }
          >
            {draft.engineUnavailability ? (
              <ProviderUnavailableNotice
                className="mt-3 mb-2.5 max-w-2xl"
                presentation={draft.engineUnavailability}
                environmentId={environmentId}
              />
            ) : null}
          </SettingsRow>

          {draft.showModelOptions && draft.activeEntry ? (
            <SettingsRow
              title={t("Reasoning")}
              description={t("How much thinking this bot spends before it answers.")}
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
                  onModelOptionsChange={draft.selectModelOptions}
                />
              }
            />
          ) : null}

          {draft.resolvedUsageCap.available ? (
            <SettingsRow
              title={t("Token hard stop")}
              description={t(
                "Stop this bot once it has spent this many tokens. Leave empty for no limit.",
              )}
              control={
                <Input
                  className="w-full sm:w-40"
                  aria-label={t("Token hard stop")}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  value={draft.usageCap}
                  placeholder={t("No limit")}
                  onChange={(event) => {
                    draft.setUsageCap(event.currentTarget.value);
                    draft.markChanged();
                  }}
                />
              }
            />
          ) : (
            <SettingsRow
              title={t("Token hard stop")}
              description={t(
                "This provider reports occupancy rather than tokens, so a token limit does not apply.",
              )}
              control={<span className="text-sm text-muted-foreground">{t("Unavailable")}</span>}
            />
          )}

          <SettingsRow title={t("Usage")} description={t("What this bot has spent so far.")}>
            <div className="mt-3 max-w-2xl pb-3.5">
              <BotUsageSection environmentId={environmentId} botId={bot.id} />
            </div>
          </SettingsRow>
        </SettingsSection>

        <SettingsSection id="workspace" title="Workspace">
          <SettingsRow
            title={t("Sandbox")}
            description={t("Where this bot runs commands and edits files.")}
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
                <SelectTrigger className="w-full sm:w-48" aria-label={t("Sandbox provider")}>
                  <SelectValue>{botSandboxLabel(draft.sandbox, t)}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {BOT_SANDBOX_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {botSandboxLabel(option.value, t)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />

          <SettingsRow
            title={t("Image generation")}
            description={t(
              "Which subscription this bot uses to create images. The chat model above stays the same.",
            )}
            control={
              <div className="flex items-center gap-1.5">
                <Select
                  value={draft.imageProvider ?? BOT_IMAGE_PROVIDER_DEFAULT}
                  onValueChange={(value) => {
                    draft.setImageProvider(botImageProviderFromSelectValue(value));
                    draft.markChanged();
                  }}
                >
                  <SelectTrigger className="w-full sm:w-56" aria-label={t("Image provider")}>
                    <SelectValue>
                      {draft.imageProvider
                        ? imageProviderLabel(draft.imageProvider)
                        : globalDefaultOptionLabel(imageSettings)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value={BOT_IMAGE_PROVIDER_DEFAULT}>
                      {globalDefaultOptionLabel(imageSettings)}
                    </SelectItem>
                    {IMAGE_PROVIDER_IDS.map((provider) => (
                      <SelectItem key={provider} value={provider}>
                        {imageProviderLabel(provider)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <Button
                  variant="ghost-muted"
                  size="xs"
                  type="button"
                  onClick={() => openSettings("image-generation", null, environmentId)}
                  aria-label={t("Open image generation settings")}
                >
                  {t("Image settings")}
                </Button>
              </div>
            }
          />

          <SettingsRow
            title={t("Memory")}
            description={t("Facts this bot keeps between chats.")}
            control={
              <Button
                variant="outline"
                size="xs"
                type="button"
                aria-label={t("Manage bot memory")}
                disabled={!threadRef}
                onClick={() => setMemoryOpen(true)}
              >
                <AppIcon className="size-3.5" icon={Brain02Icon} />
                {t("Facts and history")}
              </Button>
            }
          />

          <SettingsRow
            title={t("Channels")}
            description={t("Where this bot answers outside Akeru Bot.")}
            control={
              <Button
                variant="outline"
                size="xs"
                type="button"
                aria-label={t("Manage bot channels")}
                aria-expanded={channelsOpen}
                onClick={() => setChannelsOpen(true)}
              >
                <AppIcon className="size-3.5" icon={Link02Icon} />
                {assignedChannels.length === 0
                  ? t("No channels")
                  : t("{connected} of {total} connected", {
                      connected: connectedChannelCount,
                      total: assignedChannels.length,
                    })}
              </Button>
            }
          />
        </SettingsSection>

        <BotToolsSection
          servers={mcpServers}
          accessStatuses={accessQuery.data?.access ?? []}
          disabledIds={draft.disabledMcpServerIds}
          onDisabledIdsChange={(ids) => {
            draft.setDisabledMcpServerIds(ids);
            draft.markChanged();
          }}
          canDelegate={
            draft.activeEntry ? driverSupportsDelegation(draft.activeEntry.driverKind) : true
          }
        />
      </SettingsPageContainer>

      <div
        className="flex shrink-0 items-center justify-end gap-3 border-t border-border/70 px-5 py-3 sm:px-6"
        data-testid="bot-settings-save-bar"
      >
        <span aria-live="polite" className="mr-auto text-xs text-muted-foreground">
          {draft.saved ? (
            <span className="text-success">{t("Saved")}</span>
          ) : draft.dirty ? (
            t("Unsaved changes")
          ) : null}
        </span>
        <Button size="sm" disabled={!draft.canSave || draft.saving} onClick={draft.save}>
          {draft.saving ? t("Saving") : t("Save")}
        </Button>
      </div>

      <AvatarPickerDialog bot={bot} open={avatarOpen} onOpenChange={setAvatarOpen} />
      <BotMemorySheet open={memoryOpen} onOpenChange={setMemoryOpen} threadRef={threadRef} />
      <BotChannelsSheet bot={bot} open={channelsOpen} onOpenChange={setChannelsOpen} />
    </>
  );
}
