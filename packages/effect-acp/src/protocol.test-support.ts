import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as AcpSchema from "./_generated/schema.gen.ts";
import { jsonRpcNotification, jsonRpcRequest, jsonRpcResponse } from "./_internal/shared.ts";

const SessionCancelNotification = jsonRpcNotification(
  "session/cancel",
  AcpSchema.CancelNotification,
);

export const SessionUpdateNotification = jsonRpcNotification(
  "session/update",
  AcpSchema.SessionNotification,
);

export const ElicitationCompleteNotification = jsonRpcNotification(
  "session/elicitation/complete",
  AcpSchema.ElicitationCompleteNotification,
);

export const RequestPermissionRequest = jsonRpcRequest(
  "session/request_permission",
  AcpSchema.RequestPermissionRequest,
);

const RequestPermissionResponse = jsonRpcResponse(AcpSchema.RequestPermissionResponse);

export const ExtRequest = jsonRpcRequest("x/test", Schema.Struct({ hello: Schema.String }));

export const ExtResponse = jsonRpcResponse(Schema.Struct({ ok: Schema.Boolean }));

export const decodeSessionCancelNotification = Schema.decodeEffect(
  Schema.fromJsonString(SessionCancelNotification),
);

export const decodeExtRequest = Schema.decodeEffect(Schema.fromJsonString(ExtRequest));

export const decodeExtResponse = Schema.decodeEffect(Schema.fromJsonString(ExtResponse));

export const decodeRequestPermissionResponse = Schema.decodeEffect(
  Schema.fromJsonString(RequestPermissionResponse),
);

export const encodeUnknownJsonString = Schema.encodeUnknownSync(
  Schema.fromJsonString(Schema.Unknown),
);

export const encoder = new TextEncoder();

const mockPeerPath = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(import.meta.dirname, "../test/fixtures/acp-mock-peer.ts"),
);

const mockPeerArgs = (path: string) => [path];

export const makeHandle = (env?: Record<string, string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const path = yield* Path.Path;
    const command = ChildProcess.make(process.execPath, mockPeerArgs(yield* mockPeerPath), {
      cwd: path.join(import.meta.dirname, ".."),
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    return yield* spawner.spawn(command);
  });
