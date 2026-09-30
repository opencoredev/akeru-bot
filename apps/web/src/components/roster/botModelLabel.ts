import { createTranslator } from "@t3tools/client-runtime/i18n";
import type { ServerProvider } from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";

import { resolveAppModelSelectionState } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { getTriggerDisplayModelName } from "../chat/providerIconUtils";
import { resolveStickyBotEngine } from "./botEngineSelection";
import type { Bot } from "./types";

type Translate = ReturnType<typeof createTranslator>["t"];

const translateEnglish: Translate = createTranslator("en").t;

/**
 * Names the model a bot's next turn runs on. It resolves through the same
 * sticky engine the chat sends, so a bot without its own engine shows the
 * concrete fallback model marked "(default)" instead of a placeholder.
 */
export function resolveBotModelLabel(
  engine: Bot["engine"],
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  t: Translate = translateEnglish,
): string {
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const selection = resolveStickyBotEngine({
    engine,
    instanceEntries,
    settings,
    providers,
    defaultSelection: resolveAppModelSelectionState(settings, providers),
  });
  if (!selection?.model) return engine?.model ?? t("No provider ready");
  const model = instanceEntries
    .find((entry) => entry.instanceId === selection.instanceId)
    ?.models.find((candidate) => candidate.slug === selection.model);
  const name = model ? getTriggerDisplayModelName(model) : selection.model;
  const usesOwnEngine =
    engine !== null && engine.provider === selection.instanceId && engine.model === selection.model;
  return usesOwnEngine ? name : t("{name} (default)", { name });
}
