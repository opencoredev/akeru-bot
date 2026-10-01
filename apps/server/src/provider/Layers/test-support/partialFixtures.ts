import type { Session } from "@mastra/core/agent-controller";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import type { AkeruMastraState } from "../../AkeruMastraHarness.ts";

/** Supply only the SDK methods that the adapter exercises in this test. */
export function sessionFixture<Fixture extends object>(
  fixture: Fixture,
): Session<AkeruMastraState> {
  const partial: Partial<Session<AkeruMastraState>> = {};
  Object.assign(partial, fixture);

  return partial as Session<AkeruMastraState>;
}

/** SDK clients contain generated endpoints unrelated to the adapter under test. */
export function openCodeClientFixture<Fixture extends object>(fixture: Fixture): OpencodeClient {
  const partial: Partial<OpencodeClient> = {};
  Object.assign(partial, fixture);

  return partial as OpencodeClient;
}
