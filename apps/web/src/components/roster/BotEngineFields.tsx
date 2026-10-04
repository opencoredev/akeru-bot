import type { EnvironmentId } from "@akeru/contracts";

import { useI18n } from "../../i18n";
import { ProviderUnavailableNotice } from "../chat/ProviderUnavailableNotice";
import { TraitsPicker } from "../chat/TraitsPicker";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { BotModelPicker } from "./BotModelPicker";
import { BotUsageSection } from "./BotUsageSection";
import type { Bot } from "./types";
import type { BotProfileDraft } from "./useBotProfileDraft";

/** The Model & usage section of bot settings: model, reasoning, and spend. */
export function BotEngineFields({
  bot,
  draft,
  environmentId,
}: {
  readonly bot: Bot;
  readonly draft: BotProfileDraft;
  readonly environmentId: EnvironmentId | null;
}) {
  const { t } = useI18n();

  return (
    <SettingsSection id="model" title={t("Model & usage")}>
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
            provider={draft.engineUnavailability.provider}
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

      <SettingsRow title={t("Usage")} description={t("What this bot has spent so far.")}>
        <div className="mt-3 max-w-2xl pb-3.5">
          <BotUsageSection environmentId={environmentId} botId={bot.id} />
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
