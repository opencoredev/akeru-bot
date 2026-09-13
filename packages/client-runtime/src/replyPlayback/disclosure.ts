import type { ReplySpokenText } from "./spokenText.ts";

export function spokenTextDisclosure(spoken: ReplySpokenText) {
  if (spoken.reason === "input-too-long" || spoken.reason === "text-too-long") {
    return "This reply is too long to read aloud.";
  }
  if (spoken.reason === "too-complex") return "This reply could not be prepared for reading.";
  const parts: string[] = [];
  if (spoken.skipped.codeBlocks > 0) {
    parts.push(
      spoken.skipped.codeBlocks === 1
        ? "1 code block skipped."
        : `${spoken.skipped.codeBlocks} code blocks skipped.`,
    );
  }
  if (spoken.skipped.images > 0) {
    parts.push(
      spoken.skipped.images === 1 ? "1 image skipped." : `${spoken.skipped.images} images skipped.`,
    );
  }
  if (parts.length) return parts.join(" ");
  if (spoken.reason === "empty") return "This reply has no readable text.";
  return undefined;
}
