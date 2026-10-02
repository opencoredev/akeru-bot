import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "../baseSchemas.ts";

export const PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000;

export const PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 8;

export const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export const PROVIDER_SEND_TURN_MAX_FILE_BYTES = 10 * 1024 * 1024;

export const PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES = [
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

const PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPE_SET = new Set<string>(
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
);

/** Whether a pasted or picked image mime type can be sent on a provider turn. */
export function isProviderSendTurnSupportedImageMimeType(mimeType: string): boolean {
  return PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPE_SET.has(mimeType.toLowerCase());
}

export const PROVIDER_SEND_TURN_SUPPORTED_FILE_MIME_TYPES = [
  "application/json",
  "application/pdf",
  "application/toml",
  "application/xml",
  "application/x-yaml",
  "text/csv",
  "text/markdown",
  "text/plain",
  "text/toml",
  "text/xml",
  "text/yaml",
] as const;

const PROVIDER_SEND_TURN_SUPPORTED_FILE_MIME_TYPE_SET = new Set<string>(
  PROVIDER_SEND_TURN_SUPPORTED_FILE_MIME_TYPES,
);

export function isProviderSendTurnSupportedFileMimeType(mimeType: string): boolean {
  return PROVIDER_SEND_TURN_SUPPORTED_FILE_MIME_TYPE_SET.has(mimeType.toLowerCase());
}

const PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS = 14_000_000;

const PROVIDER_SEND_TURN_MAX_FILE_DATA_URL_CHARS = 14_000_000;

const CHAT_ATTACHMENT_ID_MAX_CHARS = 128;

const ChatAttachmentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CHAT_ATTACHMENT_ID_MAX_CHARS),
  Schema.isPattern(/^[a-z0-9_-]+$/i),
);

export type ChatAttachmentId = typeof ChatAttachmentId.Type;

export const ChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
});

export type ChatImageAttachment = typeof ChatImageAttachment.Type;

const UploadChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
  dataUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS),
  ),
});

export type UploadChatImageAttachment = typeof UploadChatImageAttachment.Type;

export const ChatFileAttachment = Schema.Struct({
  type: Schema.Literal("file"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: Schema.Literals(PROVIDER_SEND_TURN_SUPPORTED_FILE_MIME_TYPES),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES)),
});

export type ChatFileAttachment = typeof ChatFileAttachment.Type;

const UploadChatFileAttachment = Schema.Struct({
  type: Schema.Literal("file"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: Schema.Literals(PROVIDER_SEND_TURN_SUPPORTED_FILE_MIME_TYPES),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES)),
  dataUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_FILE_DATA_URL_CHARS),
  ),
});

export type UploadChatFileAttachment = typeof UploadChatFileAttachment.Type;

export const ChatAttachment = Schema.Union([ChatImageAttachment, ChatFileAttachment]);

export type ChatAttachment = typeof ChatAttachment.Type;

export const UploadChatAttachment = Schema.Union([
  UploadChatImageAttachment,
  UploadChatFileAttachment,
]);

export type UploadChatAttachment = typeof UploadChatAttachment.Type;
