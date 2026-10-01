import type { ProviderDriverKind, ProviderInstanceId } from "@akeru/contracts";
import type { ProviderInstanceEntry } from "../../providerInstances";
import type { ModelEsque } from "./providerIconUtils";

export type ModelPickerItem = {
  slug: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  instanceId: ProviderInstanceId;
  driverKind: ProviderDriverKind;
  instanceDisplayName: string;
  instanceAccentColor?: string | undefined;
  continuationGroupKey?: string | undefined;
  isLegacy?: boolean | undefined;
};

export function flattenModelPickerItems(
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>,
  entryByInstanceId: ReadonlyMap<ProviderInstanceId, ProviderInstanceEntry>,
  blockReasonByInstance: ReadonlyMap<ProviderInstanceId, string | null>,
) {
  const out: ModelPickerItem[] = [];
  for (const [instanceId, models] of modelOptionsByInstance) {
    const entry = entryByInstanceId.get(instanceId);
    if (!entry) {
      // Instance disappeared between renders (configuration change). Skip
      // its models — stale options shouldn't appear in the picker.
      continue;
    }
    if (!blockReasonByInstance.has(instanceId)) {
      continue;
    }
    for (const model of models) {
      out.push({
        slug: model.slug,
        name: model.name,
        ...(model.shortName ? { shortName: model.shortName } : {}),
        ...(model.subProvider ? { subProvider: model.subProvider } : {}),
        ...(model.isLegacy ? { isLegacy: true } : {}),
        instanceId,
        driverKind: entry.driverKind,
        instanceDisplayName: entry.displayName,
        ...(entry.accentColor ? { instanceAccentColor: entry.accentColor } : {}),
        ...(entry.continuationGroupKey ? { continuationGroupKey: entry.continuationGroupKey } : {}),
      });
    }
  }
  return out;
}
