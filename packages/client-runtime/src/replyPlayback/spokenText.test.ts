import { describe, expect, it } from "vite-plus/test";

import {
  MAX_REPLY_MARKDOWN_LENGTH,
  MAX_REPLY_SPOKEN_TEXT_LENGTH,
  replyMarkdownToSpokenText,
} from "./spokenText.js";

describe("replyMarkdownToSpokenText", () => {
  it("preserves prose, headings, lists, quotes, emphasis, and Unicode", () => {
    expect(
      replyMarkdownToSpokenText(
        [
          "# Summary",
          "",
          "Hello **Leo** and *team*. Keep snake_case and café 日本語.",
          "",
          "> A quoted __answer__.",
          "- [x] First item",
          "2. Second ~~old~~ item",
          "",
          "---",
        ].join("\n"),
      ),
    ).toEqual({
      text: "Summary\n\nHello Leo and team. Keep snake_case and café 日本語.\n\nA quoted answer.\nFirst item\nSecond old item",
      speakable: true,
      reason: null,
      skipped: { codeBlocks: 0, images: 0 },
    });
  });

  it("preserves nested list prose, paragraph continuations, and multiline inline code", () => {
    const result = replyMarkdownToSpokenText(
      "- Parent\n    - Child\n\nA paragraph\n    continued. Use `first\nsecond` here.",
    );
    expect(result.text).toBe("Parent\nChild\n\nA paragraph\ncontinued. Use first second here.");
    expect(result.skipped.codeBlocks).toBe(0);
  });

  it("removes nested emphasis without removing the content", () => {
    expect(replyMarkdownToSpokenText("***Important*** and *a **strong** answer*.").text).toBe(
      "Important and a strong answer.",
    );
  });

  it("speaks link labels, including nested formatting, not destinations or titles", () => {
    expect(
      replyMarkdownToSpokenText(
        '[**Project** [status]](https://example.com/a_(b) "Title") and [guide][docs], [docs][] or [docs].\n\n[docs]: https://secret.example/path "Documentation"',
      ).text,
    ).toBe("Project [status] and guide, docs or docs.");
  });

  it("preserves autolinks, plain URLs, entities, escapes, and inline code literally", () => {
    expect(
      replyMarkdownToSpokenText(
        "<https://example.com> <mailto:leo@example.com> https://example.org &amp; &#65; &#x1f600; \\*literal\\* `a_b * c &amp; ![x](y)` and `` `tick` ``.",
      ).text,
    ).toBe(
      "https://example.com leo@example.com https://example.org & A 😀 *literal* a_b * c &amp; ![x](y) and `tick`.",
    );
  });

  it("turns table rows into labeled values and preserves escaped and code pipes", () => {
    expect(
      replyMarkdownToSpokenText(
        [
          "| Name | Status |",
          "| :--- | ---: |",
          "| **Bot** | Ready |",
          "| A\\|B | `left|right` |",
          "",
          "After the table.",
        ].join("\n"),
      ).text,
    ).toBe("Name: Bot; Status: Ready\nName: A|B; Status: left|right\n\nAfter the table.");
  });

  it("retains a table header without data rows", () => {
    expect(replyMarkdownToSpokenText("Name | State\n--- | ---").text).toBe("Name; State");
  });

  it("skips fenced and indented code with exact disclosure counts", () => {
    expect(
      replyMarkdownToSpokenText(
        [
          "Before.",
          "",
          "```ts",
          "![not an image](x)",
          "const secret = 1;",
          "```",
          "",
          "~~~python",
          "print('hidden')",
          "~~~",
          "",
          "    indented code",
          "",
          "\tmore code",
          "",
          "After.",
        ].join("\n"),
      ),
    ).toEqual({
      text: "Before.\n\nAfter.",
      speakable: true,
      reason: null,
      skipped: { codeBlocks: 3, images: 0 },
    });
  });

  it("respects fence lengths and skips an unclosed quoted fence through the end", () => {
    const result = replyMarkdownToSpokenText(
      "Safe.\n> ````js\n> ```\n> Still code.\n> ![hidden](x)",
    );
    expect(result.text).toBe("Safe.");
    expect(result.skipped).toEqual({ codeBlocks: 1, images: 0 });
  });

  it("skips images without speaking alt text and preserves surrounding link labels", () => {
    expect(
      replyMarkdownToSpokenText(
        'Before ![private alt](https://example.com/a_(b).png) after.\n[![badge][image] **Project**](https://example.com) <img src="x" alt="hidden">\n[image]: /image.png',
      ),
    ).toEqual({
      text: "Before after.\nProject",
      speakable: true,
      reason: null,
      skipped: { codeBlocks: 0, images: 3 },
    });
  });

  it.each([
    "",
    " \n\t ",
    "---",
    "<!-- comment -->",
    "```js\nconst x = 1;\n```",
    "    code",
    "![alt](image.png)",
  ])("marks %j non-speakable", (markdown) => {
    expect(replyMarkdownToSpokenText(markdown)).toMatchObject({
      text: "",
      speakable: false,
      reason: "empty",
    });
  });

  it("does not mistake literal incomplete Markdown for a complete link or image", () => {
    const result = replyMarkdownToSpokenText(
      "Keep [label](unfinished and ![missing][unknown] and `unclosed.",
    );
    expect(result.text).toBe("Keep [label](unfinished and ![missing][unknown] and `unclosed.");
    expect(result.skipped.images).toBe(0);
  });

  it("accepts text at the exact spoken-text bound without truncation", () => {
    const text = "a".repeat(MAX_REPLY_SPOKEN_TEXT_LENGTH);
    expect(replyMarkdownToSpokenText(text)).toMatchObject({ text, speakable: true, reason: null });
  });

  it("refuses oversized spoken text instead of returning a silently truncated prefix", () => {
    expect(replyMarkdownToSpokenText("a".repeat(MAX_REPLY_SPOKEN_TEXT_LENGTH + 1))).toEqual({
      text: "",
      speakable: false,
      reason: "text-too-long",
      skipped: { codeBlocks: 0, images: 0 },
    });
  });

  it("bounds source parsing and discloses refusal even for code-only input", () => {
    expect(replyMarkdownToSpokenText("`".repeat(MAX_REPLY_MARKDOWN_LENGTH + 1))).toEqual({
      text: "",
      speakable: false,
      reason: "input-too-long",
      skipped: { codeBlocks: 0, images: 0 },
    });
    expect(replyMarkdownToSpokenText("a".repeat(MAX_REPLY_MARKDOWN_LENGTH)).reason).toBe(
      "text-too-long",
    );
  });

  it("can speak a short reply with a large omitted code block", () => {
    const result = replyMarkdownToSpokenText(`Read this.\n\n\`\`\`\n${"x".repeat(30_000)}\n\`\`\``);
    expect(result).toEqual({
      text: "Read this.",
      speakable: true,
      reason: null,
      skipped: { codeBlocks: 1, images: 0 },
    });
  });

  it("refuses excessive nesting without exposing partial speech", () => {
    let markdown = "label";
    for (let index = 0; index < 35; index++) markdown = `[${markdown}](url)`;
    expect(replyMarkdownToSpokenText(markdown)).toMatchObject({
      text: "",
      speakable: false,
      reason: "too-complex",
    });
  });

  it("handles many unmatched delimiters and returns deterministic independent results", () => {
    const markdown = `${"[".repeat(10_000)}Hello.\n![alt](x)`;
    const first = replyMarkdownToSpokenText(markdown);
    expect(first).toEqual(replyMarkdownToSpokenText(markdown));
    expect(first.skipped.images).toBe(1);
    expect(replyMarkdownToSpokenText("Hello.").skipped).toEqual({ codeBlocks: 0, images: 0 });
  });
});
