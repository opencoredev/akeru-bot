import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * How a durable fact saved to a shared project scope enters the store.
 * "ask" lands it pending approval until the user approves it; "auto" saves it
 * approved.
 */
export const SharedProjectMemorySaveMode = Schema.Literals(["ask", "auto"]);

export type SharedProjectMemorySaveMode = typeof SharedProjectMemorySaveMode.Type;

export const DEFAULT_SHARED_PROJECT_MEMORY_SAVE_MODE: SharedProjectMemorySaveMode = "ask";

/**
 * Server-authoritative durable memory switches. Durable facts are written and
 * read through `EntityMemoryRepository`, which needs these values on any
 * client surface, so they live on the server rather than in client-local
 * settings. There is deliberately no model or embedding configuration here:
 * durable memory is not a model feature.
 */
export const MemorySettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  privateBotMemory: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  sharedProjectMemory: SharedProjectMemorySaveMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SHARED_PROJECT_MEMORY_SAVE_MODE)),
  ),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));

export type MemorySettings = typeof MemorySettings.Type;

export const MemorySettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  privateBotMemory: Schema.optionalKey(Schema.Boolean),
  sharedProjectMemory: Schema.optionalKey(SharedProjectMemorySaveMode),
});

export type MemorySettingsPatch = typeof MemorySettingsPatch.Type;
