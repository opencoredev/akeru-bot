import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import {
  type ClientOrchestrationCommand,
  type IsoDateTime,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@akeru/contracts";

import {
  createAttachmentId,
  planAttachmentClaim,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import type { OrchestrationCommandReceiptRepositoryShape } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { parseBase64DataUrl } from "../imageMime.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

export const canonicalizeClientCommandTimestamps = (
  command: ClientOrchestrationCommand,
  receivedAt: IsoDateTime,
): ClientOrchestrationCommand => {
  const canonicalCommand =
    command.type === "thread.message.reaction.set"
      ? { ...command, updatedAt: receivedAt }
      : "createdAt" in command
        ? {
            ...command,
            createdAt: receivedAt,
          }
        : command;

  if (canonicalCommand.type !== "thread.turn.start" || !canonicalCommand.bootstrap?.createThread) {
    return canonicalCommand;
  }

  return {
    ...canonicalCommand,
    bootstrap: {
      ...canonicalCommand.bootstrap,
      createThread: {
        ...canonicalCommand.bootstrap.createThread,
        createdAt: receivedAt,
      },
    },
  };
};

const removeClaimedAttachmentPaths = Effect.fn("Normalizer.removeClaimedAttachmentPaths")(
  function* (attachmentPaths: ReadonlyArray<string>) {
    if (attachmentPaths.length === 0) {
      return;
    }

    const fileSystem = yield* FileSystem.FileSystem;
    yield* Effect.forEach(
      attachmentPaths,
      (attachmentPath) =>
        fileSystem.remove(attachmentPath, { force: true }).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Failed to remove an unclaimed attachment copy.", {
              attachmentPath,
              cause,
            }),
          ),
          Effect.orElseSucceed(() => undefined),
        ),
      { concurrency: 1 },
    );
  },
);

export const normalizeDispatchCommand = (command: ClientOrchestrationCommand) =>
  Effect.gen(function* () {
    const receivedAt = DateTime.formatIso(yield* DateTime.now);
    const canonicalCommand = canonicalizeClientCommandTimestamps(command, receivedAt);
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;

    const normalizeProjectWorkspaceRoot = (workspaceRoot: string) =>
      workspacePaths.normalizeWorkspaceRoot(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: cause.message,
            }),
        ),
      );

    const normalizeProjectWorkspaceRootForCreate = (
      workspaceRoot: string,
      createIfMissing: boolean | undefined,
    ) =>
      workspacePaths
        .normalizeWorkspaceRoot(workspaceRoot, {
          createIfMissing: createIfMissing === true,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: cause.message,
              }),
          ),
        );

    if (canonicalCommand.type === "project.create") {
      return {
        ...canonicalCommand,
        workspaceRoot: yield* normalizeProjectWorkspaceRootForCreate(
          canonicalCommand.workspaceRoot,
          canonicalCommand.createWorkspaceRootIfMissing,
        ),
        createWorkspaceRootIfMissing: canonicalCommand.createWorkspaceRootIfMissing === true,
      } satisfies OrchestrationCommand;
    }

    if (
      canonicalCommand.type === "project.meta.update" &&
      canonicalCommand.workspaceRoot !== undefined
    ) {
      return {
        ...canonicalCommand,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(canonicalCommand.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (canonicalCommand.type !== "thread.turn.start") {
      // SAFETY: Client-only bootstrap fields occur exclusively on turn.start, handled below.
      return canonicalCommand as OrchestrationCommand;
    }

    const claimedAttachmentPaths: string[] = [];

    const normalizedAttachments = yield* Effect.forEach(
      canonicalCommand.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          if (!("dataUrl" in attachment)) {
            const claim = planAttachmentClaim({
              attachmentsDir: serverConfig.attachmentsDir,
              threadId: canonicalCommand.threadId,
              attachmentId: attachment.id,
            });

            if (!claim.ok) {
              return yield* new OrchestrationDispatchCommandError({
                message: `Attachment '${attachment.name}' cannot be sent: ${claim.reason}.`,
              });
            }

            const info = yield* fileSystem.stat(claim.currentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationDispatchCommandError({
                    message: `Attachment '${attachment.name}' cannot be sent: attachment not found.`,
                    cause,
                  }),
              ),
            );

            if (Number(info.size) !== attachment.sizeBytes) {
              return yield* new OrchestrationDispatchCommandError({
                message: `Attachment '${attachment.name}' cannot be sent: stored size does not match.`,
              });
            }

            const normalizedAttachment =
              attachment.type === "file"
                ? { ...attachment, id: claim.finalId }
                : {
                    ...attachment,
                    id: claim.finalId,
                    mimeType: attachment.mimeType.toLowerCase(),
                  };

            const expectedPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment: normalizedAttachment,
            });

            if (expectedPath !== claim.finalPath) {
              return yield* new OrchestrationDispatchCommandError({
                message: `Attachment '${attachment.name}' cannot be sent: ${attachment.type} type does not match the upload.`,
              });
            }

            // Keep the pending copy until the turn succeeds. A failed thread
            // bootstrap can then retry with a fresh thread id.
            yield* fileSystem.copyFile(claim.currentPath, claim.finalPath).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationDispatchCommandError({
                    message: `Failed to claim attachment '${attachment.name}' for this chat.`,
                    cause,
                  }),
              ),
            );
            claimedAttachmentPaths.push(claim.finalPath);

            return normalizedAttachment;
          }

          const parsed = parseBase64DataUrl(attachment.dataUrl);

          if (
            !parsed ||
            parsed.mimeType !== attachment.mimeType.toLowerCase() ||
            (attachment.type === "image" && !parsed.mimeType.startsWith("image/"))
          ) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Invalid attachment payload for '${attachment.name}'.`,
            });
          }

          const bytes = Buffer.from(parsed.base64, "base64");

          const maxBytes =
            attachment.type === "image"
              ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
              : PROVIDER_SEND_TURN_MAX_FILE_BYTES;

          if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Attachment '${attachment.name}' is empty or too large.`,
            });
          }

          const attachmentId = createAttachmentId(canonicalCommand.threadId);

          if (!attachmentId) {
            return yield* new OrchestrationDispatchCommandError({
              message: "Failed to create a safe attachment id.",
            });
          }

          const persistedAttachment =
            attachment.type === "file"
              ? {
                  type: "file" as const,
                  id: attachmentId,
                  name: attachment.name,
                  mimeType: attachment.mimeType,
                  sizeBytes: bytes.byteLength,
                }
              : {
                  type: "image" as const,
                  id: attachmentId,
                  name: attachment.name,
                  mimeType: parsed.mimeType.toLowerCase(),
                  sizeBytes: bytes.byteLength,
                };

          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: persistedAttachment,
          });

          if (!attachmentPath) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Failed to resolve persisted path for '${attachment.name}'.`,
            });
          }

          yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to create attachment directory for '${attachment.name}'.`,
                }),
            ),
          );
          yield* fileSystem.writeFile(attachmentPath, bytes).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to persist attachment '${attachment.name}'.`,
                }),
            ),
          );

          return persistedAttachment;
        }),
      { concurrency: 1 },
    ).pipe(Effect.tapError(() => removeClaimedAttachmentPaths(claimedAttachmentPaths)));

    return {
      ...canonicalCommand,
      message: {
        ...canonicalCommand.message,
        attachments: normalizedAttachments,
      },
    } satisfies OrchestrationCommand;
  });

const isPendingUpload = (
  attachment: Extract<
    ClientOrchestrationCommand,
    { type: "thread.turn.start" }
  >["message"]["attachments"][number],
) =>
  !("dataUrl" in attachment) &&
  parseThreadSegmentFromAttachmentId(attachment.id) === PENDING_ATTACHMENT_THREAD_SEGMENT;

export const cleanupFailedUploadedAttachments = Effect.fn(
  "Normalizer.cleanupFailedUploadedAttachments",
)(function* (command: ClientOrchestrationCommand, normalizedCommand: OrchestrationCommand) {
  if (command.type !== "thread.turn.start" || normalizedCommand.type !== "thread.turn.start") {
    return;
  }

  const serverConfig = yield* ServerConfig;
  const claimedPaths: string[] = [];

  for (const [index, attachment] of normalizedCommand.message.attachments.entries()) {
    const original = command.message.attachments[index];

    if (!original || !isPendingUpload(original)) {
      continue;
    }

    const claimedPath = resolveAttachmentPath({
      attachmentsDir: serverConfig.attachmentsDir,
      attachment,
    });

    if (claimedPath) {
      claimedPaths.push(claimedPath);
    }
  }

  yield* removeClaimedAttachmentPaths(claimedPaths);
});

/**
 * Dispatches a normalized command and removes the pending uploads it claimed
 * unless the engine accepted it. The engine commits a queued command even
 * after its caller stops waiting, so `dispatch` runs uninterruptibly and the
 * command receipt, not the caller's exit, decides whether a committed message
 * references the files. `awaitReady` stays cancellable
 * because nothing has reached the engine while it waits. Set `interruptible`
 * only for a dispatch that already awaits its own engine results
 * uninterruptibly, such as a thread bootstrap.
 */
export const dispatchKeepingAcceptedUploads = <A, E, R, E2, R2>(input: {
  readonly command: ClientOrchestrationCommand;
  readonly normalizedCommand: OrchestrationCommand;
  readonly awaitReady: Effect.Effect<void, E2, R2>;
  readonly dispatch: Effect.Effect<A, E, R>;
  readonly interruptible: boolean;
  readonly receipts: Option.Option<
    Pick<OrchestrationCommandReceiptRepositoryShape, "getByCommandId">
  >;
}): Effect.Effect<A, E | E2, R | R2 | ServerConfig | FileSystem.FileSystem> => {
  const { command, normalizedCommand } = input;

  if (
    command.type !== "thread.turn.start" ||
    normalizedCommand.type !== "thread.turn.start" ||
    !command.message.attachments.some(isPendingUpload)
  ) {
    return input.dispatch;
  }

  const { commandId, threadId } = normalizedCommand;

  const isAccepted = Option.isSome(input.receipts)
    ? input.receipts.value
        .getByCommandId({ commandId })
        .pipe(
          Effect.map(
            (receipt) =>
              Option.isSome(receipt) &&
              receipt.value.status === "accepted" &&
              receipt.value.aggregateId === threadId,
          ),
        )
    : Effect.succeed(false);

  const removeUnacceptedUploads = isAccepted.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Kept claimed uploads because the turn start outcome is unknown.", {
        commandId,
        cause,
      }).pipe(Effect.as(true)),
    ),
    Effect.flatMap((accepted) =>
      accepted ? Effect.void : cleanupFailedUploadedAttachments(command, normalizedCommand),
    ),
  );

  return Effect.uninterruptibleMask((restore) =>
    restore(input.awaitReady).pipe(
      Effect.andThen(input.interruptible ? restore(input.dispatch) : input.dispatch),
      Effect.onError(() => removeUnacceptedUploads),
    ),
  );
};
