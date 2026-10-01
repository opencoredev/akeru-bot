import { useAtomValue } from "@effect/atom-react";
import {
  BotId,
  IMAGE_PROVIDER_IDS,
  type EnvironmentId,
  type ImageProviderId,
} from "@akeru/contracts";
import {
  botImageProviderOptionLabel,
  globalDefaultOptionLabel,
} from "@akeru/client-runtime/image-generation";
import { squashAtomCommandFailure } from "@akeru/client-runtime/state/runtime";
import { driverSupportsDelegation } from "@akeru/shared/delegationProviders";
import { Brain02Icon, Link02Icon } from "@hugeicons/core-free-icons";
import { useBlocker } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useI18n } from "../../i18n";
import { openSettings } from "../../settingsDialogStore";
import { botEnvironment } from "../../state/bots";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { environmentMcpServersAtom } from "../../state/mcpServers";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { AppIcon } from "../ui/app-icon";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { AvatarPickerDialog } from "./AvatarPickerDialog";
import { BotAvatarView } from "./BotAvatarView";
import { BotChannelsSheet } from "./BotChannelsSheet";
import { BotEngineFields } from "./BotEngineFields";
import { BotIdentityFields } from "./BotIdentityFields";
import { BotMemorySheet } from "./BotMemorySheet";
import { BotPersonalityToneField } from "./BotPersonalityToneField";
import { BotToolsSection } from "./BotToolsSection";
import { BOT_SANDBOX_OPTIONS, botSandboxLabel } from "./botSandbox";
import type { Bot } from "./types";
import { useBotThreadRef } from "./useBotThreadRef";
import {
  BOT_IMAGE_PROVIDER_DEFAULT,
  botImageProviderFromSelectValue,
  useBotProfileDraft,
  type BotProfileUpdate,
} from "./useBotProfileDraft";

const NO_ENVIRONMENT = "" as EnvironmentId;

/** Edits one bot's profile as a draft, saved together from the bottom bar. */
export function BotSettingsForm({
  bot,
  onSave,
  onDeleted,
}: {
  readonly bot: Bot;
  readonly onSave: (input: BotProfileUpdate) => Promise<boolean>;
  readonly onDeleted: () => void;
}) {
  const { t } = useI18n();
  const environmentId = usePrimaryEnvironmentId();
  const mcpServers = useAtomValue(environmentMcpServersAtom(environmentId ?? NO_ENVIRONMENT));
  const deleteBot = useAtomCommand(botEnvironment.delete, { reportFailure: false });
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
  const [deleting, setDeleting] = useState(false);
  const deletedRef = useRef(false);

  const shouldBlockNavigation = useCallback(async () => {
    if (deletedRef.current || !draft.dirty) return false;
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

  const onDeleteBot = useCallback(() => {
    if (!environmentId) return;
    const confirmation = requestConfirmDialog(
      t("Delete {name}? Its chats stay in your history. This cannot be undone.", {
        name: bot.name,
      }),
      { variant: "destructive" },
    );
    if (!confirmation) return;
    setDeleting(true);
    void confirmation.then(async (confirmed) => {
      if (!confirmed) {
        setDeleting(false);
        return;
      }
      const result = await deleteBot({
        environmentId,
        input: { botId: BotId.make(bot.id) },
      });
      setDeleting(false);
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: t("Could not delete {name}", { name: bot.name }),
          description: error instanceof Error ? error.message : t("The command failed."),
        });
        return;
      }
      deletedRef.current = true;
      onDeleted();
    });
  }, [bot, environmentId, deleteBot, onDeleted, t]);

  return (
    <>
      <SettingsPageContainer>
        <div className="flex items-center gap-4 px-3 pb-1 sm:px-4">
          <BotAvatarView avatar={bot.avatar} name={draft.name || bot.name} className="size-14" />
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight">
              {draft.name || bot.name}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t("Set up how this bot works with you.")}
            </p>
          </div>
        </div>
        <nav
          aria-label={t("Bot settings sections")}
          className="flex gap-1 overflow-x-auto px-2 sm:px-3"
        >
          {(
            [
              ["identity", t("Identity")],
              ["behavior", t("Behavior")],
              ["model", t("Model & usage")],
              ["workspace", t("Workspace")],
              ["tools", t("Tools")],
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

        <BotIdentityFields bot={bot} draft={draft} onChangeAvatar={() => setAvatarOpen(true)} />

        <SettingsSection id="behavior" title={t("Behavior")}>
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

        <BotEngineFields bot={bot} draft={draft} environmentId={environmentId} />

        <SettingsSection id="workspace" title={t("Workspace")}>
          <SettingsRow
            title={t("Sandbox")}
            description={t("Where this bot runs commands and edits files.")}
            control={
              <Select
                value={draft.sandbox}
                onValueChange={(value) => {
                  if (value === null) return;
                  if (
                    value !== "default" &&
                    !BOT_SANDBOX_OPTIONS.some((option) => option.value === value)
                  )
                    return;
                  draft.setSandbox(value as typeof draft.sandbox);
                  draft.markChanged();
                }}
              >
                <SelectTrigger className="w-full sm:w-48" aria-label={t("Sandbox provider")}>
                  <SelectValue>{botSandboxLabel(draft.sandbox, t)}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="default">{botSandboxLabel("default", t)}</SelectItem>
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

        <SettingsSection title={t("Danger")}>
          <SettingsRow
            title={t("Delete bot")}
            description={t("Remove {name} from the roster. Its chats stay in your history.", {
              name: bot.name,
            })}
            control={
              <Button
                variant="destructive"
                size="sm"
                disabled={deleting || !environmentId}
                onClick={onDeleteBot}
              >
                {deleting ? t("Deleting…") : t("Delete")}
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
