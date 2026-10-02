import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";
import { expect, it } from "vite-plus/test";

import { SubscriptionAuthService } from "./service.ts";
import { fixture } from "./testUtils/subscriptionAuthStorage.ts";
import { runWithNodeServices } from "./testUtils/subscriptionAuthService.ts";

it("uses the creator's clock for default health timestamps and token expiry", async () => {
  const { directory, authPath } = fixture();
  const now = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-09-30T12:34:56.789Z"));
  NodeFS.writeFileSync(
    authPath,
    JSON.stringify({
      anthropic: {
        type: "oauth",
        access: "unexpired-access",
        refresh: "refresh",
        expires: now + 1,
      },
    }),
  );

  try {
    const service = await runWithNodeServices(
      Effect.gen(function* () {
        const clock = yield* Clock.Clock;

        return yield* SubscriptionAuthService.make(authPath).pipe(
          Effect.provideService(Clock.Clock, {
            monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
            monotonicTimeNanos: clock.monotonicTimeNanos,
            currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
            currentTimeNanos: clock.currentTimeNanos,
            sleep: (duration) => clock.sleep(duration),
            currentTimeMillisUnsafe: () => now,
            currentTimeMillis: Effect.succeed(now),
          }),
        );
      }),
    );

    expect(await service.getAccessToken("anthropic")).toBe("unexpired-access");
    service.recordRequestSuccess("anthropic");
    expect(service.statuses().find((status) => status.provider === "anthropic")).toMatchObject({
      health: "healthy",
      lastSuccessfulRequestAt: "2026-09-30T12:34:56.789Z",
    });
    expect(
      service.statuses([], now + 1).find((status) => status.provider === "anthropic")?.health,
    ).toBe("expired");
    service.recordRequestFailure("anthropic", "failed");
    expect(
      service.statuses().find((status) => status.provider === "anthropic")?.lastFailedRequest,
    ).toEqual({ at: "2026-09-30T12:34:56.789Z", message: "failed" });
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
