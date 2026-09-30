import { type ProviderInstanceId } from "@akeru/contracts";

import {
  providerInstancePickerBlockReason,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { useI18n } from "../../i18n";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { getTriggerDisplayModelName, type ModelEsque } from "../chat/providerIconUtils";

export interface BotModelChoice {
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly label: string;
  /** Why this model cannot be picked right now, or null when it can. */
  readonly disabledReason: string | null;
}

export function buildBotModelChoices(
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>,
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>,
): ReadonlyArray<BotModelChoice> {
  return instanceEntries.flatMap((entry) => {
    const disabledReason = providerInstancePickerBlockReason(entry);
    return (modelOptionsByInstance.get(entry.instanceId) ?? []).map((model) => ({
      instanceId: entry.instanceId,
      model: model.slug,
      label: getTriggerDisplayModelName(model),
      disabledReason,
    }));
  });
}

/** The established T3 model menu, scoped to model selection for one bot. */
export function BotModelPicker({
  activeInstanceId,
  model,
  instanceEntries,
  modelOptionsByInstance,
  disabled = false,
  onChange,
}: {
  readonly activeInstanceId: ProviderInstanceId;
  readonly model: string;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  readonly disabled?: boolean;
  readonly onChange: (instanceId: ProviderInstanceId, model: string) => void;
}) {
  const { t } = useI18n();
  return (
    <ProviderModelPicker
      activeInstanceId={activeInstanceId}
      model={model}
      lockedProvider={null}
      lockedContinuationGroupKey={null}
      instanceEntries={instanceEntries}
      modelOptionsByInstance={modelOptionsByInstance}
      compact
      disabled={disabled}
      triggerAriaLabel={t("Change model")}
      triggerClassName="max-w-52"
      onInstanceModelChange={onChange}
    />
  );
}
