import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { afterEach } from "vite-plus/test";
import { writeAttachmentIfMissing } from "../../attachmentStore.ts";
import { type ChannelRuntimeDependencies } from "../ChannelRuntimeTypes.ts";

const attachmentsDirs = new Set<string>();

export const makeAttachmentsDir = () => {
  const dir = NodePath.join(
    NodeOS.tmpdir(),
    `akeru-channel-attachments-${NodeCrypto.randomUUID()}`,
  );

  attachmentsDirs.add(dir);

  return dir;
};

export const attachmentWriterFor =
  (attachmentsDir: string): ChannelRuntimeDependencies["writeAttachmentIfMissing"] =>
  (attachment, bytes) =>
    writeAttachmentIfMissing({ attachmentsDir, attachment, bytes }).pipe(
      Effect.provide(NodeServices.layer),
    );

export const unusedAttachmentWriter: ChannelRuntimeDependencies["writeAttachmentIfMissing"] = () =>
  Effect.die("unused attachment writer");

afterEach(() => {
  for (const dir of attachmentsDirs) NodeFS.rmSync(dir, { recursive: true, force: true });
  attachmentsDirs.clear();
});
