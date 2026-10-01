import type { MessageEntry } from "./openCodeAdapterHarness.ts";
import type { Session } from "@mastra/core/agent-controller";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import type { AkeruMastraState } from "../../AkeruMastraHarness.ts";

type SessionFixture = Partial<
  Omit<Session<AkeruMastraState>, "state" | "mode" | "model" | "permissions">
> & {
  state?: Partial<Session<AkeruMastraState>["state"]>;
  mode?: Partial<Session<AkeruMastraState>["mode"]>;
  model?: Partial<Session<AkeruMastraState>["model"]>;
  permissions?: Partial<Session<AkeruMastraState>["permissions"]>;
};

/** Supply only the SDK methods that the adapter exercises in this test. */
export function sessionFixture(fixture: SessionFixture): Session<AkeruMastraState> {
  // SAFETY: Tests supply checked SDK methods and exercise only that subset.
  return fixture as Session<AkeruMastraState>;
}

type EndpointFixture<Method, Output> = Method extends (...args: infer Args) => infer _Result
  ? (...args: Args) => Promise<Output>
  : never;

type SessionEndpoints = OpencodeClient["session"];

type SessionResult = {
  data: { id: string; directory?: string; parentID?: string; revert?: { messageID: string } };
};

type OpenCodeClientFixture = {
  session?: {
    create?: EndpointFixture<SessionEndpoints["create"], SessionResult>;
    get?: EndpointFixture<SessionEndpoints["get"], SessionResult>;
    update?: EndpointFixture<SessionEndpoints["update"], SessionResult>;
    fork?: EndpointFixture<SessionEndpoints["fork"], SessionResult>;
    abort?: EndpointFixture<SessionEndpoints["abort"], void>;
    children?: EndpointFixture<SessionEndpoints["children"], { data: Array<{ id: string }> }>;
    promptAsync?: EndpointFixture<SessionEndpoints["promptAsync"], void>;
    messages?: EndpointFixture<SessionEndpoints["messages"], { data: Array<MessageEntry> }>;
    revert?: EndpointFixture<SessionEndpoints["revert"], void>;
  };
  event?: {
    subscribe?: EndpointFixture<
      OpencodeClient["event"]["subscribe"],
      { stream: AsyncIterable<unknown> }
    >;
  };
  permission?: { reply?: EndpointFixture<OpencodeClient["permission"]["reply"], void> };
  question?: { reply?: EndpointFixture<OpencodeClient["question"]["reply"], void> };
  mcp?: { add?: EndpointFixture<OpencodeClient["mcp"]["add"], { data: boolean }> };
};

/** Check SDK arguments and the response fields consumed by the adapter. */
export function openCodeClientFixture(fixture: OpenCodeClientFixture): OpencodeClient {
  // SAFETY: Tests exercise only the supplied endpoints and consumed result fields.
  // Generated transport metadata and unused endpoints are intentionally absent;
  // raw messages/events allow malformed input to exercise the adapter's decoders.
  return fixture as OpencodeClient & OpenCodeClientFixture;
}
