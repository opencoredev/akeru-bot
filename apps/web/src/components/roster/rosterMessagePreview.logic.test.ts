import { describe, expect, it } from "vite-plus/test";

import { flattenMarkdownPreview, resolveLatestRosterMessage } from "./rosterMessagePreview.logic";

describe("flattenMarkdownPreview with raw HTML", () => {
  it("shows the text HTML renders, not its tags", () => {
    expect(flattenMarkdownPreview("<b>Done</b> and <i>shipped</i>")).toBe("Done and shipped");
    expect(flattenMarkdownPreview("First<br>second")).toBe("First second");
    expect(flattenMarkdownPreview("<div>Tom &amp; Jerry &#8217;s &#x1F680; &bogus;</div>")).toBe(
      "Tom & Jerry \u2019s \u{1F680} &bogus;",
    );
    expect(
      flattenMarkdownPreview("<div>Copyright &copy; 2026 *not* 1. [x] \\ &hellip;</div>"),
    ).toBe("Copyright \u00a9 2026 *not* 1. [x] \\ \u2026");
    expect(flattenMarkdownPreview("<div>\nBlock\n</div>\n\nAfter <!-- note -->")).toBe(
      "Block After",
    );
  });
});

describe("resolveLatestRosterMessage", () => {
  const messages = (
    entries: Array<{ role: "user" | "assistant" | "system"; text: string; at: string }>,
  ) =>
    entries.map((entry, index) => ({
      id: `message-${index}`,
      role: entry.role,
      text: entry.text,
      turnId: null,
      streaming: false,
      createdAt: entry.at,
      updatedAt: entry.at,
    })) as Parameters<typeof resolveLatestRosterMessage>[1];

  it("uses the latest real user or provider message and its timestamp", () => {
    expect(
      resolveLatestRosterMessage(
        { text: "handoff", at: "2026-08-20T10:00:00.000Z" },
        messages([
          { role: "user", text: "Question", at: "2026-08-20T10:01:00.000Z" },
          { role: "assistant", text: "Answer", at: "2026-08-20T10:02:00.000Z" },
        ]),
      ),
    ).toEqual({ text: "Answer", at: "2026-08-20T10:02:00.000Z" });
  });

  it("keeps a newer handoff preview and ignores system or empty messages", () => {
    const fallback = { text: "Newest prompt", at: "2026-08-20T10:03:00.000Z" };
    expect(
      resolveLatestRosterMessage(
        fallback,
        messages([
          { role: "assistant", text: "Older answer", at: "2026-08-20T10:02:00.000Z" },
          { role: "system", text: "Internal", at: "2026-08-20T10:04:00.000Z" },
          { role: "assistant", text: "", at: "2026-08-20T10:05:00.000Z" },
        ]),
      ),
    ).toEqual(fallback);
  });

  it("ignores a newer fallback sent to another chat", () => {
    const answer = messages([
      { role: "assistant", text: "Yesterday", at: "2026-08-20T10:00:00.000Z" },
    ]);
    const fallback = { text: "Today", at: "2026-08-20T12:00:00.000Z", threadId: "chat-b" };
    expect(resolveLatestRosterMessage(fallback, answer, "chat-a")).toEqual({
      text: "Yesterday",
      at: "2026-08-20T10:00:00.000Z",
    });
    expect(resolveLatestRosterMessage(fallback, answer, "chat-b")).toMatchObject({
      text: "Today",
    });
  });

  it("drops the fallback once the bot has no open chat", () => {
    const at = "2026-08-20T12:00:00.000Z";
    expect(resolveLatestRosterMessage({ text: "Ship it", at, threadId: "chat-a" }, [], null)).toBe(
      null,
    );
    expect(resolveLatestRosterMessage({ text: "Ship it", at }, [], null)).toBeNull();
  });

  it("flattens markdown and skips messages that flatten to nothing", () => {
    expect(
      resolveLatestRosterMessage(
        { text: "**Handoff** note", at: "2026-08-20T10:00:00.000Z" },
        messages([
          { role: "assistant", text: "Q3 came to **$1,200**", at: "2026-08-20T10:01:00.000Z" },
          { role: "assistant", text: "![chart](chart.png)", at: "2026-08-20T10:02:00.000Z" },
        ]),
      ),
    ).toEqual({ text: "Q3 came to $1,200", at: "2026-08-20T10:01:00.000Z" });
    expect(resolveLatestRosterMessage({ text: "**Handoff** note", at: "x" }, [])).toEqual({
      text: "Handoff note",
      at: "x",
    });
  });

  it("ignores a newer fallback that flattens to empty and keeps the older answer", () => {
    expect(
      resolveLatestRosterMessage(
        { text: "![chart](chart.png)", at: "2026-08-20T10:05:00.000Z" },
        messages([{ role: "assistant", text: "Older answer", at: "2026-08-20T10:02:00.000Z" }]),
      ),
    ).toEqual({ text: "Older answer", at: "2026-08-20T10:02:00.000Z" });
    expect(resolveLatestRosterMessage({ text: "![chart](chart.png)", at: "x" }, [])).toBeNull();
  });

  it("ignores messages from parent-linked child threads", () => {
    expect(
      resolveLatestRosterMessage(
        { text: "Own conversation", at: "2026-08-20T10:00:00.000Z" },
        messages([
          { role: "assistant", text: "Delegated task", at: "2026-08-20T10:05:00.000Z" },
        ]).map((message) => ({ ...message, parentThreadId: "parent-thread" })),
      ),
    ).toEqual({ text: "Own conversation", at: "2026-08-20T10:00:00.000Z" });
  });
});

describe("flattenMarkdownPreview", () => {
  it("strips emphasis, code, and strikethrough but keeps the words", () => {
    expect(
      flattenMarkdownPreview("**September at Akeru** was _busy_, *very* ~~slow~~ `fast`"),
    ).toBe("September at Akeru was busy, very slow fast");
  });

  it("keeps link labels and drops images", () => {
    expect(
      flattenMarkdownPreview(
        "See [the report](https://example.com/r) ![chart](chart.png) and <https://akeru.dev>",
      ),
    ).toBe("See the report and https://akeru.dev");
  });

  it("drops headings, list and quote markers, fences, and rules onto one line", () => {
    expect(
      flattenMarkdownPreview(
        [
          "## Summary",
          "> Quoted note",
          "- first",
          "* [x] second",
          "1. third",
          "---",
          "```ts",
          "const total = 1;",
          "```",
        ].join("\n"),
      ),
    ).toBe("Summary Quoted note first second third const total = 1;");
  });

  it("leaves snake_case identifiers and lone symbols alone", () => {
    expect(flattenMarkdownPreview("rename user_id to 2 * 3 = 6")).toBe(
      "rename user_id to 2 * 3 = 6",
    );
  });

  it("keeps asterisks inside code spans and URLs literal", () => {
    expect(flattenMarkdownPreview("`a*b*c` stays literal")).toBe("a*b*c stays literal");
    expect(flattenMarkdownPreview("see https://example.com/a*b*c and _em_")).toBe(
      "see https://example.com/a*b*c and em",
    );
    expect(flattenMarkdownPreview("mail <mailto:a*b@c.example> here")).toBe(
      "mail mailto:a*b@c.example here",
    );
  });

  it("never confuses literal text with internal markers", () => {
    expect(flattenMarkdownPreview("marker \u00010\u0001 stays")).toBe("marker \u00010\u0001 stays");
    expect(flattenMarkdownPreview("`code` then \u00010\u0001")).toBe("code then \u00010\u0001");
  });

  it("keeps link and image syntax inside code spans literal", () => {
    expect(flattenMarkdownPreview("`[docs](https://example.com)`")).toBe(
      "[docs](https://example.com)",
    );
    expect(flattenMarkdownPreview("`![chart](chart.png)`")).toBe("![chart](chart.png)");
  });

  it("drops emphasis around a bare URL", () => {
    expect(flattenMarkdownPreview("**https://example.com**")).toBe("https://example.com");
    expect(flattenMarkdownPreview("see _https://example.com/a_b_ now")).toBe(
      "see https://example.com/a_b now",
    );
  });

  it("previews a long answer from its opening lines", () => {
    const opening = "**Done.** Updated the [report](https://example.com/r).";
    expect(flattenMarkdownPreview(`${opening}\n\n${"- more detail\n".repeat(500)}`)).toMatch(
      /^Done\. Updated the report\. more detail/,
    );
    expect(flattenMarkdownPreview(`${"![shot](a.png)\n".repeat(100)}\nfinally words`)).toBe(
      "finally words",
    );
  });

  it("never cuts a long message inside link, image, or code syntax", () => {
    const alt = "long alt text ".repeat(55);
    expect(flattenMarkdownPreview(`Intro ![${alt}](chart.png) then answer`)).toBe(
      "Intro then answer",
    );
    const label = "label ".repeat(120);
    expect(flattenMarkdownPreview(`See [${label}](https://example.com) now`)).toBe(
      `See ${label.trim()} now`,
    );
    const code = "x ".repeat(400);
    expect(flattenMarkdownPreview(`\`${code}\` done`)).toBe(`${code.trim()} done`);
    const fenced = `\`\`\`\n${"line\n\n".repeat(200)}\`\`\`\n\n**after**`;
    expect(flattenMarkdownPreview(fenced)).not.toContain("`");
    // A long alt text with a line break once put the old cut inside the image.
    const wrapped = `Intro ![${"alt ".repeat(4_100)}\ncontinued](chart.png) then answer`;
    expect(flattenMarkdownPreview(wrapped)).toBe("Intro then answer");
  });

  it("previews one enormous line without parsing all of it", () => {
    const alt = "alt ".repeat(10_000);
    const line = `Intro **bold** \`code\` [label](https://example.com) ![${alt}](chart.png) then answer`;
    expect(flattenMarkdownPreview(line)).toBe("Intro bold code label");
    const words = `**Start** ${"word ".repeat(10_000)}`;
    const preview = flattenMarkdownPreview(words);
    expect(preview).toMatch(/^Start word word/);
    expect(preview.length).toBeLessThanOrEqual(2_000);
    expect(flattenMarkdownPreview(`Opening paragraph.\n\n${line}`)).toBe("Opening paragraph.");
    expect(
      flattenMarkdownPreview(`Example \`![literal](chart.png)\` ${"word ".repeat(10_000)}`),
    ).toMatch(/^Example !\[literal\]\(chart\.png\) word/);
  });

  it("drops nested and escaped image alt text in the rough preview", () => {
    const tail = "z".repeat(20_000);
    const nested = flattenMarkdownPreview(
      `Intro ![public [x] SECRET](chart.png) then answer${tail}`,
    );
    expect(nested).toMatch(/^Intro then answerz/);
    expect(nested).not.toContain("SECRET");
    const escaped = flattenMarkdownPreview(
      `Intro ![public \\] SECRET](chart.png) then answer${tail}`,
    );
    expect(escaped).toMatch(/^Intro then answerz/);
    expect(escaped).not.toContain("SECRET");
    // With no balanced close in the window, the rest of the window goes.
    expect(flattenMarkdownPreview(`Intro ![open [SECRET ${tail}`)).toBe("Intro");
    expect(flattenMarkdownPreview(`Intro ![alt](chart.png (SECRET ${tail}`)).toBe("Intro");
  });

  it("drops an image whose label holds backticks, and treats escaped backticks as prose", () => {
    const tail = "z".repeat(20_000);
    const ticked = flattenMarkdownPreview(
      `Intro ![alt \`code\` SECRET](chart.png) then answer${tail}`,
    );
    expect(ticked).toMatch(/^Intro then answerz/);
    expect(ticked).not.toContain("SECRET");
    const escaped = flattenMarkdownPreview(
      `Intro \\\` ![SECRET](chart.png) \\\` then answer${tail}`,
    );
    expect(escaped).not.toContain("SECRET");
  });

  it("resolves a reference image whose definition sits in a later chunk", () => {
    const paragraph = `Opening ${"word ".repeat(120)}![private diagram][chart] end`;
    const preview = flattenMarkdownPreview(`${paragraph}\n\n[chart]: chart.png\n\nMore text`);
    expect(preview).not.toContain("private diagram");
    expect(preview).not.toContain("[chart]");
  });

  it("bounds the rough preview to a prefix of the message", () => {
    // Leading whitespace counts against the window instead of being scanned.
    expect(flattenMarkdownPreview(`${" ".repeat(30_000)}word`)).toBe("");
    expect(flattenMarkdownPreview(`${" ".repeat(1_990)}word ${"z".repeat(20_000)}`)).toBe(
      `word ${"z".repeat(5)}`,
    );
  });

  it("flattens whitespace-heavy messages", () => {
    // Line prefixes use [ \t], not \s, so no multiline pattern crosses a
    // newline and rescans the blank lines after it. This checks the output
    // only; a wall-clock bound would be flaky on a loaded runner.
    expect(flattenMarkdownPreview(`${"\n".repeat(20_000)}done`)).toBe("done");
    expect(flattenMarkdownPreview(`${"\n \t\n".repeat(5_000)}- item\n\n> quote`)).toBe(
      "item quote",
    );
  });
});
