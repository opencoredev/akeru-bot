import { expectTypeOf } from "vite-plus/test";
import { openCodeClientFixture, sessionFixture } from "./partialFixtures.ts";

// Compile-only negative cases. The server typecheck must reject each input.
export function rejectedSdkFixtureInputs() {
  expectTypeOf<{ sendMessage: number }>().not.toExtend<Parameters<typeof sessionFixture>[0]>();
  expectTypeOf<{ session: number }>().not.toExtend<Parameters<typeof openCodeClientFixture>[0]>();
  expectTypeOf<{ session: { get: number } }>().not.toExtend<
    Parameters<typeof openCodeClientFixture>[0]
  >();
  expectTypeOf<{ model: { switch: number } }>().not.toExtend<
    Parameters<typeof sessionFixture>[0]
  >();
}
