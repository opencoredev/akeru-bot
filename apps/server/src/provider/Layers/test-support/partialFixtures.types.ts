import { openCodeClientFixture, sessionFixture } from "./partialFixtures.ts";

// Compile-only negative cases. The server typecheck must reject each input.
export function rejectedSdkFixtureInputs() {
  // @ts-expect-error sendMessage is an SDK method, never a numeric field.
  sessionFixture({ sendMessage: 123 });
  // @ts-expect-error session is an endpoint group, never a numeric field.
  openCodeClientFixture({ session: 123 });
  // @ts-expect-error Nested SDK endpoint methods are checked too.
  openCodeClientFixture({ session: { get: 123 } });
  // @ts-expect-error Session nested members retain their SDK method signatures.
  sessionFixture({ model: { switch: 123 } });
}
