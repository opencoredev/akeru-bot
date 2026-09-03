import {
  isProviderSendTurnSupportedFileMimeType,
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type UploadChatFileAttachment,
  type UploadChatImageAttachment,
} from "@t3tools/contracts";

const FILE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  csv: "text/csv",
  json: "application/json",
  markdown: "text/markdown",
  md: "text/markdown",
  pdf: "application/pdf",
  toml: "application/toml",
  txt: "text/plain",
  xml: "application/xml",
  yaml: "application/x-yaml",
  yml: "application/x-yaml",
};

export type BotFileAttachmentKind =
  | Pick<UploadChatFileAttachment, "mimeType" | "type">
  | Pick<UploadChatImageAttachment, "mimeType" | "type">;

export function resolveBotFileAttachment(
  file: Pick<File, "name" | "size" | "type">,
): BotFileAttachmentKind | null {
  const declaredMimeType = file.type.trim().toLowerCase();
  if (isProviderSendTurnSupportedImageMimeType(declaredMimeType)) {
    return file.size > 0 && file.size <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
      ? { type: "image", mimeType: declaredMimeType }
      : null;
  }
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  const mimeType = isProviderSendTurnSupportedFileMimeType(declaredMimeType)
    ? declaredMimeType
    : FILE_MIME_BY_EXTENSION[extension];
  return mimeType && file.size > 0 && file.size <= PROVIDER_SEND_TURN_MAX_FILE_BYTES
    ? { type: "file", mimeType: mimeType as UploadChatFileAttachment["mimeType"] }
    : null;
}
