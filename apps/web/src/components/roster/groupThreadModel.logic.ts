import { type BotEngine, type ModelSelection, ProviderInstanceId } from "@akeru/contracts";

/**
 * The model a group turn runs on: the responding member's own engine, else the project's
 * default, else the app default. Null when none of them is set.
 */
export function groupModelSelection(
  engine: BotEngine | null | undefined,
  projectDefault: ModelSelection | null | undefined,
  appDefault: ModelSelection | null,
): ModelSelection | null {
  return engine
    ? {
        instanceId: ProviderInstanceId.make(engine.provider),
        model: engine.model,
        ...(engine.options ? { options: engine.options } : {}),
      }
    : (projectDefault ?? appDefault);
}
