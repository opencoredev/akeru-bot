import { useAtomValue } from "@effect/atom-react";
import type { BotEngine } from "@akeru/contracts";
import { useMemo } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { useI18n } from "../../i18n";
import { resolveAppModelSelectionState } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { primaryServerProvidersAtom } from "../../state/server";
import {
  botEngineCatalog,
  botEngineUnavailability,
  resolveStickyBotEngine,
} from "./botEngineSelection";

/**
 * The engine a bot answers with and whether it can run right now. `blocked`
 * turns off Send and calls; a temporary failure does not block, since the next
 * attempt may succeed. `catalog` holds the skills and commands the `$` and `/` menus offer.
 */
export function useBotEngineAvailability(engine: BotEngine | null) {
  const settings = usePrimarySettings();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const { t } = useI18n();
  return useMemo(() => {
    const instanceEntries = sortProviderInstanceEntries(
      applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
    );
    const defaultSelection = resolveAppModelSelectionState(settings, providers);
    const selection = resolveStickyBotEngine({
      engine,
      instanceEntries,
      settings,
      providers,
      defaultSelection,
    });
    const unavailability = botEngineUnavailability(selection, instanceEntries, t);
    return {
      instanceEntries,
      selection,
      catalog: botEngineCatalog(selection, instanceEntries),
      unavailability,
      blocked: unavailability !== null && unavailability.reason !== "temporary-failure",
    };
  }, [engine, providers, settings, t]);
}
