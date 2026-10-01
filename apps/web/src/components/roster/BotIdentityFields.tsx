import { Edit02Icon } from "@hugeicons/core-free-icons";

import { useI18n } from "../../i18n";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { AppIcon } from "../ui/app-icon";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { BotAvatarView } from "./BotAvatarView";
import type { Bot } from "./types";
import type { BotProfileDraft } from "./useBotProfileDraft";

/** The Identity section of bot settings: avatar, name, label, and description. */
export function BotIdentityFields({
  bot,
  draft,
  onChangeAvatar,
}: {
  readonly bot: Bot;
  readonly draft: BotProfileDraft;
  readonly onChangeAvatar: () => void;
}) {
  const { t } = useI18n();
  return (
    <SettingsSection id="identity" title={t("Identity")}>
      <SettingsRow
        title={t("Avatar")}
        description={t("Shown in the roster, the chat header, and anywhere this bot speaks.")}
        control={
          <button
            type="button"
            aria-label={t("Change bot avatar")}
            onClick={onChangeAvatar}
            className="group relative rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <BotAvatarView avatar={bot.avatar} name={draft.name || bot.name} className="size-14" />
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
  );
}
