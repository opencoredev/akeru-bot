import type { BotEngine, ModelSelection } from "@akeru/contracts";

import {
  isProviderInstancePickerSelectable,
  NO_PROVIDER_MODEL_SELECTION,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { resolveStickyBotEngine } from "./botEngineSelection";

type GroupModelContext = Omit<Parameters<typeof resolveStickyBotEngine>[0], "engine">;

/**
 * The model a group member answers with: the same pick as the member's 1:1 chat, so a
 * member without an engine borrows the app's selectable default. Null when no provider can run.
 */
export function groupModelSelection(
  engine: BotEngine | null,
  context: GroupModelContext,
): ModelSelection | null {
  return resolveStickyBotEngine({ ...context, engine });
}

/** Whether a group member's model runs on a provider this client can pick right now. */
export function groupModelSelectionReady(
  selection: ModelSelection | null,
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>,
): selection is ModelSelection {
  return (
    selection !== null &&
    selection.instanceId !== NO_PROVIDER_MODEL_SELECTION.instanceId &&
    instanceEntries.some(
      (entry) =>
        entry.instanceId === selection.instanceId && isProviderInstancePickerSelectable(entry),
    )
  );
}
