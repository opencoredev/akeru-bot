// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import { DesktopHostTelemetryMessage, DesktopTelemetryControlMessage } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  DesktopTelemetryDescriptorUnavailable,
  DesktopTelemetryProtocolMismatch,
  DesktopTelemetryDecodeFailed,
  DesktopTelemetryStreamFailed,
  type DesktopTelemetryReceiverError,
  DesktopTelemetryControlFailed,
  DesktopTelemetryControlStalled,
} from "./DesktopTelemetryTypes.ts";

export const decodeMessage = Schema.decodeUnknownEffect(DesktopHostTelemetryMessage);

export const encodeControlMessage = Schema.encodeEffect(
  Schema.fromJsonString(DesktopTelemetryControlMessage),
);

export const isDescriptorUnavailable = Schema.is(DesktopTelemetryDescriptorUnavailable);

export const isProtocolMismatch = Schema.is(DesktopTelemetryProtocolMismatch);

export const isDecodeFailed = Schema.is(DesktopTelemetryDecodeFailed);

export const isStreamFailed = Schema.is(DesktopTelemetryStreamFailed);

export function normalizeReceiverError(error: unknown): DesktopTelemetryReceiverError {
  if (
    isDescriptorUnavailable(error) ||
    isProtocolMismatch(error) ||
    isDecodeFailed(error) ||
    isStreamFailed(error)
  ) {
    return error;
  }

  return new DesktopTelemetryDecodeFailed({ cause: error });
}

export function messageVersion(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const version = Reflect.get(value, "version");

  return typeof version === "number" ? version : undefined;
}

export const writeAllToFileDescriptor = Effect.fn(
  "resourceTelemetry.desktopTelemetryReceiver.writeAllToFileDescriptor",
)(function* (fd: number, payload: Buffer) {
  let offset = 0;

  while (offset < payload.byteLength) {
    const written = yield* Effect.callback<number, DesktopTelemetryControlFailed>(
      (resume, signal) => {
        if (signal.aborted) return;

        try {
          NodeFS.write(
            fd,
            payload,
            offset,
            payload.byteLength - offset,
            null,
            (error, bytesWritten) => {
              if (error) {
                resume(
                  Effect.fail(
                    new DesktopTelemetryControlFailed({
                      fd,
                      operation: "write",
                      cause: error,
                    }),
                  ),
                );

                return;
              }

              resume(Effect.succeed(bytesWritten));
            },
          );
        } catch (cause) {
          resume(
            Effect.fail(
              new DesktopTelemetryControlFailed({
                fd,
                operation: "write",
                cause,
              }),
            ),
          );
        }
      },
    );

    yield* requireDesktopTelemetryWriteProgress(fd, payload.byteLength - offset, written);
    offset += written;
  }
});

export function requireDesktopTelemetryWriteProgress(
  fd: number,
  remainingBytes: number,
  written: number,
): Effect.Effect<void, DesktopTelemetryControlStalled> {
  return written > 0
    ? Effect.void
    : Effect.fail(new DesktopTelemetryControlStalled({ fd, remainingBytes }));
}

export function openDesktopTelemetryReadable(fd: number) {
  // Filesystem reads on inherited sockets cannot be cancelled while the peer stays open.
  if (NodeFS.fstatSync(fd).isSocket()) {
    return new NodeNet.Socket({ fd, readable: true, writable: false });
  }

  // Keep file, FIFO, and Windows non-socket descriptor handling unchanged.
  return NodeFS.createReadStream("", { fd, autoClose: true });
}
