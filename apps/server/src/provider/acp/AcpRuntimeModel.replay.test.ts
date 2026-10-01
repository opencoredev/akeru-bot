import { it as effectIt } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/schema";
import {
  sessionUpdateIsReplay,
  waitForSessionLoadReplayIdle,
  type SessionLoadGate,
} from "./AcpRuntimeModel.ts";

effectIt.effect("finishes session replay at the configured idle deadline", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0);
    const gateRef = yield* Ref.make<Option.Option<SessionLoadGate>>(
      Option.some({
        active: true,
        lastActivityAtMillis: 0,
        idleGap: Duration.millis(101),
        initializeResult: { protocolVersion: 1 },
      }),
    );
    const result = yield* waitForSessionLoadReplayIdle({ gateRef }).pipe(Effect.forkChild);

    yield* TestClock.adjust(Duration.millis(101));

    expect((yield* Fiber.join(result))._meta).toMatchObject({
      t3SessionLoadReady: "replay_idle",
    });
  }),
);

describe("AcpRuntimeModel", () => {
  it("detects Grok session replay updates from _meta.isReplay", () => {
    expect(
      sessionUpdateIsReplay({
        _meta: { isReplay: true },
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "replayed" },
        },
      } satisfies EffectAcpSchema.SessionNotification),
    ).toBe(true);
    expect(
      sessionUpdateIsReplay({
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "live" },
        },
      } satisfies EffectAcpSchema.SessionNotification),
    ).toBe(false);
  });
});
