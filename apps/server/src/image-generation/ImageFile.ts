import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

export const readImageFile = Effect.fn("readImageFile")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fs.open(path, { flag: "r" });
      const metadata = yield* handle.stat;

      if (metadata.size === 0n || metadata.size > BigInt(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES))
        return null;
      const chunks: Uint8Array[] = [];
      let total = 0;

      while (total <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        const chunk = new Uint8Array(
          Math.min(64 * 1024, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1 - total),
        );

        const bytesRead = Number(yield* handle.read(chunk));

        if (bytesRead === 0) break;
        total += bytesRead;
        chunks.push(chunk.subarray(0, bytesRead));
      }

      return total > 0 && total <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
        ? new Uint8Array(Buffer.concat(chunks, total))
        : null;
    }),
  ).pipe(
    Effect.orElseSucceed(() => null),
    Effect.catchDefect(() => Effect.succeed(null)),
  );
});
