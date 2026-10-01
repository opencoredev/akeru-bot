import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as AcpSchema from "./_generated/schema.gen.ts";
import { jsonRpcNotification, jsonRpcRequest, jsonRpcResponse } from "./_internal/shared.ts";

export const InitializeRequest = jsonRpcRequest("initialize", AcpSchema.InitializeRequest);

export const InitializeResponse = jsonRpcResponse(AcpSchema.InitializeResponse);

export const ExtRequest = jsonRpcRequest("x/test", Schema.Struct({ hello: Schema.String }));

export const ExtResponse = jsonRpcResponse(Schema.Struct({ ok: Schema.Boolean }));

const PromptRequest = jsonRpcRequest("session/prompt", AcpSchema.PromptRequest);

export const PromptResponse = jsonRpcResponse(AcpSchema.PromptResponse);

export const SessionUpdateNotification = jsonRpcNotification(
  "session/update",
  AcpSchema.SessionNotification,
);

export const decodePromptRequestLine = Schema.decodeEffect(Schema.fromJsonString(PromptRequest));

export const XAiPromptCompleteNotification = jsonRpcNotification(
  "_x.ai/session/prompt_complete",
  Schema.Struct({
    sessionId: Schema.String,
    promptId: Schema.String,
    stopReason: Schema.String,
    agentResult: Schema.NullOr(Schema.Unknown),
  }),
);

export const XAiQueueChangedNotification = jsonRpcNotification(
  "_x.ai/queue/changed",
  Schema.Struct({
    sessionId: Schema.String,
    entries: Schema.Array(Schema.Unknown),
  }),
);

export const XAiSessionsChangedNotification = jsonRpcNotification(
  "_x.ai/sessions/changed",
  Schema.Struct({
    upserted: Schema.Array(Schema.Unknown),
    removed: Schema.Array(Schema.Unknown),
  }),
);

export const mockPeerPath = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(import.meta.dirname, "../test/fixtures/acp-mock-peer.ts"),
);

export const mockPeerArgs = (path: string) => [path];

export function concatBytes(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  const batch = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;

  for (const chunk of chunks) {
    batch.set(chunk, offset);
    offset += chunk.length;
  }

  return batch;
}
