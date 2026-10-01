// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off

import * as NodeFSP from "node:fs/promises";
import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@akeru/contracts";

export async function readImageFile(path: string): Promise<Uint8Array | null> {
  try {
    const handle = await NodeFSP.open(path, "r");

    try {
      const metadata = await handle.stat();

      if (metadata.size === 0 || metadata.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) return null;
      const chunks: Uint8Array[] = [];
      let total = 0;

      while (total <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        const chunk = new Uint8Array(
          Math.min(64 * 1024, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1 - total),
        );

        const { bytesRead } = await handle.read(chunk);

        if (bytesRead === 0) break;
        total += bytesRead;
        chunks.push(chunk.subarray(0, bytesRead));
      }

      return total > 0 && total <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
        ? new Uint8Array(Buffer.concat(chunks, total))
        : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
