import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as EffectAcpSchema from "effect-acp/schema";

import { isRecord } from "./AcpProtocolValues.ts";
import { type SessionLoadGate } from "./AcpRuntimeTypes.ts";
import { syntheticLoadSessionResponseFromInitialize } from "./AcpSessionModel.ts";

export function sessionUpdateIsReplay(params: EffectAcpSchema.SessionNotification): boolean {
  const meta = params._meta;

  return isRecord(meta) && meta.isReplay === true;
}

export const waitForSessionLoadReplayIdle = (input: {
  readonly gateRef: Ref.Ref<Option.Option<SessionLoadGate>>;
}): Effect.Effect<EffectAcpSchema.LoadSessionResponse, never> =>
  Effect.gen(function* () {
    while (true) {
      const gate = yield* Ref.get(input.gateRef);

      if (
        Option.isSome(gate) &&
        gate.value.active &&
        gate.value.lastActivityAtMillis !== undefined
      ) {
        const idleGapMillis = Duration.toMillis(gate.value.idleGap);
        const nowMillis = yield* Clock.currentTimeMillis;

        if (nowMillis - gate.value.lastActivityAtMillis >= idleGapMillis) {
          return syntheticLoadSessionResponseFromInitialize(gate.value.initializeResult);
        }

        yield* Effect.sleep(
          Duration.millis(
            Math.max(1, idleGapMillis - (nowMillis - gate.value.lastActivityAtMillis)),
          ),
        );
        continue;
      }

      yield* Effect.sleep(Duration.millis(25));
    }
  });
