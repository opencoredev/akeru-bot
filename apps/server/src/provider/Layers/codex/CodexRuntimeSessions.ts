import { type ProviderSession, TurnId } from "@akeru/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import { type CodexThreadSnapshot } from "./CodexRuntimeState.ts";
import { readResumeCursorThreadId } from "./CodexRuntimeOpening.ts";

export function currentProviderThreadId(session: ProviderSession): string | undefined {
  return readResumeCursorThreadId(session.resumeCursor);
}

export function updateSession(
  sessionRef: Ref.Ref<ProviderSession>,
  updates: Partial<ProviderSession> | ((session: ProviderSession) => Partial<ProviderSession>),
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* Ref.update(sessionRef, (session) => ({
      ...session,
      ...(typeof updates === "function" ? updates(session) : updates),
      updatedAt,
    }));
  });
}

export function parseThreadSnapshot(
  response: EffectCodexSchema.V2ThreadReadResponse | EffectCodexSchema.V2ThreadRollbackResponse,
): CodexThreadSnapshot {
  return {
    threadId: response.thread.id,
    turns: response.thread.turns.map((turn) => ({
      id: TurnId.make(turn.id),
      items: turn.items,
    })),
  };
}
