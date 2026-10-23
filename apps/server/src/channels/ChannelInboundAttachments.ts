import * as NodeCrypto from "node:crypto";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_SUPPORTED_FILE_MIME_TYPES,
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
  type ChatAttachment,
  type MessageId,
  type ThreadId,
} from "@akeru/contracts";
import { type Message } from "chat";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { deterministicAttachmentId } from "../attachmentStore.ts";
import {
  type ChannelRuntimeContext,
  type DownloadedChannelAttachments,
  type DownloadedChannelFile,
  type DownloadedChannelFileKind,
  type InboundChannelAttachment,
} from "./ChannelRuntimeTypes.ts";

const ATTACHMENT_NAME_MAX_CHARS = 255;

export const INBOUND_DOWNLOAD_PERMITS = 4;

const DOWNLOAD_TIMEOUT = "30 seconds";

const oneLine = (value: string | undefined) => (value ?? "").replace(/[\p{Cc}\s]+/gu, " ").trim();

/** The attachment schema counts UTF-16 units, and the cap must not split a surrogate pair. */
const cappedName = (name: string) => {
  let capped = "";

  for (const character of oneLine(name)) {
    if (capped.length + character.length > ATTACHMENT_NAME_MAX_CHARS) break;
    capped += character;
  }

  return capped.trim();
};

export const inboundAttachments = (message: Message): ReadonlyArray<InboundChannelAttachment> =>
  message.attachments.map((attachment) => {
    const fetchData = attachment.fetchData;
    const mimeType = oneLine(attachment.mimeType);
    const url = oneLine(attachment.url);

    return {
      name: cappedName(attachment.name ?? "") || attachment.type,
      ...(mimeType ? { mimeType } : {}),
      ...(attachment.size !== undefined ? { sizeBytes: attachment.size } : {}),
      ...(url ? { url } : {}),
      ...(fetchData
        ? {
            fetch: async () => {
              const data = await fetchData();

              return data instanceof Uint8Array ? data : new Uint8Array(data);
            },
          }
        : {}),
    };
  });

const supportedKind = (mimeType: string | undefined) => {
  const normalized = (mimeType ?? "").replace(/;.*/s, "").trim().toLowerCase();
  const image = PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES.find((type) => type === normalized);

  if (image) {
    return {
      kind: { type: "image", mimeType: image },
      maxBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
    } as const;
  }

  const file = PROVIDER_SEND_TURN_SUPPORTED_FILE_MIME_TYPES.find((type) => type === normalized);

  return file
    ? ({
        kind: { type: "file", mimeType: file },
        maxBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES,
      } as const)
    : null;
};

const megabytes = (bytes: number) => `${bytes / 1024 / 1024} MB`;

interface Note {
  readonly note: string;
}

interface SharedFile {
  readonly name: string;
}

interface Download extends SharedFile {
  readonly kind: DownloadedChannelFileKind;
  readonly maxBytes: number;
  readonly sizeDeclared: boolean;
  readonly fetch: () => Promise<Uint8Array>;
}

const notAttached = (file: SharedFile, reason: string): Note => ({
  note: `[Shared file "${file.name}" was not attached: ${reason}]`,
});

const tooLarge = (file: SharedFile, maxBytes: number) =>
  notAttached(file, `larger than ${megabytes(maxBytes)}`);

const notes = (
  outcomes: ReadonlyArray<Note | { readonly file: unknown } | { readonly attachment: unknown }>,
) => outcomes.flatMap((outcome) => ("note" in outcome ? [outcome.note] : []));

const planDownload = (inbound: InboundChannelAttachment): Note | Download => {
  const supported = supportedKind(inbound.mimeType);

  if (!supported) return notAttached(inbound, `unsupported type ${inbound.mimeType ?? "unknown"}`);

  if ((inbound.sizeBytes ?? 0) > supported.maxBytes) return tooLarge(inbound, supported.maxBytes);

  if (!inbound.fetch) {
    return notAttached(
      inbound,
      inbound.url ? `no download available, ${inbound.url}` : "no download available",
    );
  }

  return {
    name: inbound.name,
    kind: supported.kind,
    maxBytes: supported.maxBytes,
    sizeDeclared: inbound.sizeBytes !== undefined,
    fetch: inbound.fetch,
  };
};

const capDownloadsAtTurnLimit = (plans: ReadonlyArray<Note | Download>) => {
  let slots = 0;

  return plans.map((planned) => {
    if ("note" in planned) return planned;
    slots += 1;

    return slots > PROVIDER_SEND_TURN_MAX_ATTACHMENTS
      ? notAttached(planned, `more than ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files in one message`)
      : planned;
  });
};

const download = Effect.fn("downloadChannelFile")(function* (
  downloads: Semaphore.Semaphore,
  planned: Download,
) {
  const { name } = planned;

  const bytes = yield* Effect.tryPromise(planned.fetch).pipe(
    Effect.timeout(DOWNLOAD_TIMEOUT),
    // The SDK buffers a whole file before its size is known, so a file with no declared size
    // (WhatsApp sends none) holds every permit and buffers alone.
    downloads.withPermits(planned.sizeDeclared ? 1 : INBOUND_DOWNLOAD_PERMITS),
    Effect.tapError((error) =>
      Effect.logWarning("Failed to download a file shared in a channel message.", {
        name,
        category: Cause.isTimeoutError(error) ? "timeout" : "download",
      }),
    ),
    Effect.option,
  );

  if (Option.isNone(bytes)) return notAttached(planned, "download failed");

  if (bytes.value.byteLength === 0) return notAttached(planned, "the file is empty");

  if (bytes.value.byteLength > planned.maxBytes) return tooLarge(planned, planned.maxBytes);

  return {
    file: {
      name,
      kind: planned.kind,
      bytes: bytes.value,
      sha256Hex: NodeCrypto.createHash("sha256").update(bytes.value).digest("hex"),
    },
  };
});

export const downloadInboundAttachments = Effect.fn("downloadInboundAttachments")(function* (
  downloads: Semaphore.Semaphore,
  attachments: ReadonlyArray<InboundChannelAttachment>,
) {
  const outcomes = yield* Effect.forEach(
    capDownloadsAtTurnLimit(attachments.map(planDownload)),
    (planned): Effect.Effect<Note | { readonly file: DownloadedChannelFile }> =>
      "note" in planned ? Effect.succeed(planned) : download(downloads, planned),
    { concurrency: "unbounded" },
  );

  return {
    files: outcomes.flatMap((outcome) => ("file" in outcome ? [outcome.file] : [])),
    notes: notes(outcomes),
  } satisfies DownloadedChannelAttachments;
});

export const channelFileAttachmentId = (
  threadId: ThreadId,
  messageId: MessageId,
  sha256Hex: string,
  occurrence: number,
) => deterministicAttachmentId(threadId, `${messageId}\0${sha256Hex}\0${occurrence}`);

const saveFile = Effect.fn("saveChannelFile")(function* (
  ctx: ChannelRuntimeContext,
  threadId: ThreadId,
  messageId: MessageId,
  file: DownloadedChannelFile,
  occurrence: number,
) {
  const { name } = file;
  const id = channelFileAttachmentId(threadId, messageId, file.sha256Hex, occurrence);

  if (!id) return notAttached(file, "it could not be saved");

  const saved = yield* ctx.deps
    .writeAttachmentIfMissing({ ...file.kind, id, name }, file.bytes)
    .pipe(
      Effect.tapError(() =>
        Effect.logWarning("Failed to save a file shared in a channel message.", {
          threadId,
          name,
          category: "save",
        }),
      ),
      Effect.option,
    );

  return Option.isSome(saved)
    ? { attachment: saved.value }
    : notAttached(file, "it could not be saved");
});

export const saveDownloadedFiles = Effect.fn("saveDownloadedFiles")(function* (
  ctx: ChannelRuntimeContext,
  input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly files: ReadonlyArray<DownloadedChannelFile>;
  },
) {
  const occurrences = new Map<string, number>();

  const outcomes = yield* Effect.forEach(
    input.files,
    (file) => {
      const occurrence = occurrences.get(file.sha256Hex) ?? 0;
      occurrences.set(file.sha256Hex, occurrence + 1);

      return saveFile(ctx, input.threadId, input.messageId, file, occurrence);
    },
    { concurrency: 1 },
  );

  return {
    attachments: outcomes.flatMap(
      (outcome): ReadonlyArray<ChatAttachment> =>
        "attachment" in outcome ? [outcome.attachment] : [],
    ),
    notes: notes(outcomes),
  };
});
