import { describe, expect, it } from "vite-plus/test";
import { spokenTextDisclosure } from "./disclosure.ts";
import { replyMarkdownToSpokenText } from "./spokenText.ts";

describe("spoken text disclosure", () => {
  it("explains skipped non-prose and empty or oversized replies", () => {
    expect(
      spokenTextDisclosure(
        replyMarkdownToSpokenText("```ts\nsecret()\n```\n\n![diagram](https://example.com/a.png)"),
      ),
    ).toBe("1 code block skipped. 1 image skipped.");
    expect(spokenTextDisclosure(replyMarkdownToSpokenText(""))).toBe(
      "This reply has no readable text.",
    );
    expect(spokenTextDisclosure(replyMarkdownToSpokenText("Hello"))).toBeUndefined();
  });
});
