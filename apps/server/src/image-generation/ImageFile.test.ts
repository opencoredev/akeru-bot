// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off

import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@akeru/contracts";
import { it, expect } from "vite-plus/test";
import { readImageFile } from "./ImageFile.ts";

it("loads multiple input images and rejects empty, missing, and oversized files", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "akeru-image-input-"));

  try {
    const first = NodePath.join(directory, "first.png");
    const second = NodePath.join(directory, "second.png");
    const empty = NodePath.join(directory, "empty.png");
    const oversized = NodePath.join(directory, "oversized.png");
    await Promise.all([
      NodeFSP.writeFile(first, new Uint8Array([1, 2, 3])),
      NodeFSP.writeFile(second, new Uint8Array([4, 5])),
      NodeFSP.writeFile(empty, ""),
      NodeFSP.writeFile(oversized, ""),
    ]);
    await NodeFSP.truncate(oversized, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1);
    expect(await Promise.all([readImageFile(first), readImageFile(second)])).toEqual([
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5]),
    ]);

    for (const path of [empty, oversized, NodePath.join(directory, "missing.png")])
      expect(await readImageFile(path)).toBeNull();
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
