import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as ChannelRuntime from "./channels/ChannelRuntime.ts";

import { ServerRuntimeStartupError } from "./startupCommandGate.ts";

export interface StartupOptions {
  readonly activate?: Effect.Effect<void>;
  readonly awaitAuxiliaryParked?: Effect.Effect<void>;
  readonly abort?: (error: ServerRuntimeStartupError) => Effect.Effect<void>;
}

/**
 * Reconnects saved channel bindings at startup. Restore errors can wrap provider responses, so
 * the logs carry only the bot, provider, and failure category, never the error or its cause.
 */
export const restoreExternalChannels = (
  runtime: Pick<ChannelRuntime.ChannelRuntimeShape, "restoreConnectedChannels">,
) =>
  runtime.restoreConnectedChannels.pipe(
    Effect.flatMap((failures) =>
      Effect.forEach(
        failures,
        (failure) =>
          Effect.logWarning("failed to restore external channel", {
            botId: failure.botId,
            provider: failure.provider,
            category: failure.category,
          }),
        { discard: true },
      ),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("external channel startup restore failed", {
        interrupted: Cause.hasInterruptsOnly(cause),
      }),
    ),
  );
