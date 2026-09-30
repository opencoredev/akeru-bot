import { describe, expect, it } from "vite-plus/test";

import { ImageResponseTooLargeError, readBoundedText } from "./boundedResponse.ts";

function streamedResponse(chunks: ReadonlyArray<string>): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
  );
}

describe("readBoundedText", () => {
  it("reads a body within the limit", async () => {
    await expect(readBoundedText(streamedResponse(["ab", "cd"]), "Grok", 4)).resolves.toBe("abcd");
  });

  it("stops reading once a streamed body passes the limit", async () => {
    await expect(
      readBoundedText(streamedResponse(["ab", "cd", "e"]), "Grok", 4),
    ).rejects.toBeInstanceOf(ImageResponseTooLargeError);
  });

  it("rejects a declared length over the limit before reading", async () => {
    const response = new Response("abcdef", { headers: { "content-length": "6" } });
    await expect(readBoundedText(response, "Grok", 4)).rejects.toThrow(
      "Grok returned a response larger than the image size limit.",
    );
  });
});
