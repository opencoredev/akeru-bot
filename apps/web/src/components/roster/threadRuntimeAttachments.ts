import { resolveBotFileAttachment } from "./botFileAttachment";

/** The chat title a send proposes: the prompt, else the first file's name, capped at 80. */
export function threadTitle(prompt: string, files: readonly File[]): string {
  const seed = prompt || (files[0] ? `File: ${files[0].name}` : "New chat");
  return seed.length > 80 ? `${seed.slice(0, 79)}…` : seed;
}

/** Reads a file as a base64 data URL labelled with the resolved, not the declared, MIME type. */
export function readFileAsDataUrl(file: File, mimeType: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener(
      "error",
      () => reject(reader.error ?? new Error(`Could not read ${file.name}.`)),
      { once: true },
    );
    reader.addEventListener(
      "load",
      () =>
        typeof reader.result === "string"
          ? resolve(`data:${mimeType};base64,${reader.result.split(",", 2)[1] ?? ""}`)
          : reject(new Error(`Could not read ${file.name}.`)),
      { once: true },
    );
    reader.readAsDataURL(file);
  });
}

/** Turns composer files into turn attachments, rejecting with a readable message on failure. */
export function readThreadTurnAttachments(files: readonly File[]) {
  return Promise.all(
    files.map(async (file) => {
      const attachment = resolveBotFileAttachment(file);
      if (!attachment) throw new Error(`This file type is not supported: ${file.name}`);
      return {
        ...attachment,
        name: file.name,
        sizeBytes: file.size,
        dataUrl: await readFileAsDataUrl(file, attachment.mimeType),
      };
    }),
  );
}
