// @effect-diagnostics nodeBuiltinImport:off - Source guard reads this module's renderer map.
import * as NodeFS from "node:fs";

import { EnvironmentId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  usePreparedConnection: () => ({ _tag: "Loading" }),
}));
vi.mock("../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
}));
vi.mock("../localShellAccess", () => ({
  useLocalShellAccess: () => ({ isLocal: true, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));

import ChatMarkdown, {
  canUseMarkdownFileShellActions,
  hasMarkdownFilePrimaryAction,
  orderedListGutterStyle,
  shouldUseMarkdownFileBrowserPrimaryAction,
} from "./ChatMarkdown";

describe("ChatMarkdown streaming renderers", () => {
  it("keeps one renderer map instead of recreating types when text streams", () => {
    const source = NodeFS.readFileSync(new URL("./ChatMarkdown.tsx", import.meta.url), "utf8");

    expect(source).toContain("const ChatMarkdownRendererContext");
    expect(source).toContain("const CHAT_MARKDOWN_COMPONENTS: Components");
    expect(source).toContain("components={CHAT_MARKDOWN_COMPONENTS}");
    expect(source).toContain("pre: function MarkdownPre");
    expect(source).toContain("details: function MarkdownDetailsRenderer");
    expect(source).not.toMatch(/useMemo<Components>/);
  });

  it("still renders streamed fences and details after extra trailing text", () => {
    const fence = ["```text", "First code block", "```", "", "Streaming reply"].join("\n");
    const html = renderToStaticMarkup(
      <ChatMarkdown cwd="/tmp/project" text={`${fence} 9`} isStreaming />,
    );

    expect(html).toContain('data-language="text"');
    expect(html).toContain("First code block");
    expect(html).toContain("Streaming reply 9");
  });
});

describe("canUseMarkdownFileShellActions", () => {
  const environmentId = EnvironmentId.make("environment-1");

  it("allows editor and file manager actions for local environments", () => {
    expect(canUseMarkdownFileShellActions(environmentId, { isLocal: true, isResolved: true })).toBe(
      true,
    );
  });

  it("hides shell actions until the environment mode is resolved", () => {
    expect(
      canUseMarkdownFileShellActions(environmentId, { isLocal: true, isResolved: false }),
    ).toBe(false);
  });

  it("hides editor and file manager actions for remote environments", () => {
    expect(
      canUseMarkdownFileShellActions(environmentId, { isLocal: false, isResolved: true }),
    ).toBe(false);
  });

  it("hides shell actions when no environment owns the markdown", () => {
    expect(canUseMarkdownFileShellActions(null, { isLocal: true, isResolved: true })).toBe(false);
  });
});

describe("hasMarkdownFilePrimaryAction", () => {
  it("keeps the chip interactive when an editor or browser can open it", () => {
    expect(
      hasMarkdownFilePrimaryAction({
        canOpenInEditor: true,
        canOpenInBrowser: false,
      }),
    ).toBe(true);
    expect(
      hasMarkdownFilePrimaryAction({
        canOpenInEditor: false,
        canOpenInBrowser: true,
      }),
    ).toBe(true);
  });

  it("removes the link affordance when no primary action can open the file", () => {
    expect(
      hasMarkdownFilePrimaryAction({
        canOpenInEditor: false,
        canOpenInBrowser: false,
      }),
    ).toBe(false);
  });
});

describe("ChatMarkdown file option chips", () => {
  it("keeps the fallback button text selectable", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown cwd="/tmp/project" text="[Source](/tmp/project/src/main.ts)" />,
    );

    expect(html).toContain("<button");
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain("select-text");
  });
});

describe("ChatMarkdown settings chips", () => {
  it("opens the exact Settings pane without an external-browser target", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown cwd={undefined} text="[Error inbox](grokbot://app/v1/settings?id=bot-inbox)" />,
    );

    expect(html).toContain("chat-markdown-settings-link");
    expect(html).toContain("Open Settings &gt; Advanced &gt; Diagnostics");
    expect(html).not.toContain('target="_blank"');
  });
});

describe("shouldUseMarkdownFileBrowserPrimaryAction", () => {
  it("uses the browser when it is the only available primary action", () => {
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        iconPath: "/tmp/report.html",
        canOpenInEditor: false,
        canOpenInBrowser: true,
      }),
    ).toBe(true);
  });

  it("prefers the editor for HTML files when one is available", () => {
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        iconPath: "/tmp/report.html",
        canOpenInEditor: true,
        canOpenInBrowser: true,
      }),
    ).toBe(false);
  });

  it("continues to open PDF files in the browser by default", () => {
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        iconPath: "/tmp/report.pdf",
        canOpenInEditor: true,
        canOpenInBrowser: true,
      }),
    ).toBe(true);
  });
});

describe("orderedListGutterStyle", () => {
  it("leaves the default gutter alone for single-digit lists", () => {
    expect(orderedListGutterStyle(9, undefined)).toBeUndefined();
  });

  it("leaves the default gutter alone for two-digit lists", () => {
    expect(orderedListGutterStyle(99, undefined)).toBeUndefined();
  });

  it("leaves the default gutter alone for a two-digit list that starts above 1", () => {
    // start=50 + 49 items => last marker is "98", still two digits.
    expect(orderedListGutterStyle(49, 50)).toBeUndefined();
  });

  it("widens the gutter once the last marker reaches three digits", () => {
    // item 100 is the bug from #6512: a 100-item list starting at 1.
    expect(orderedListGutterStyle(100, undefined)).toEqual({ "--list-gutter": "4ch" });
  });

  it("accounts for a non-default start attribute", () => {
    // start=95 + 9 items => last marker is "103", three digits.
    expect(orderedListGutterStyle(9, 95)).toEqual({ "--list-gutter": "4ch" });
    expect(orderedListGutterStyle(5, "999995")).toEqual({ "--list-gutter": "7ch" });
  });

  it("scales further for four-digit markers", () => {
    expect(orderedListGutterStyle(1000, undefined)).toEqual({ "--list-gutter": "5ch" });
  });

  it("uses the widest marker and includes a negative start's minus sign", () => {
    expect(orderedListGutterStyle(1001, -1000)).toEqual({ "--list-gutter": "6ch" });
    expect(orderedListGutterStyle(3, -15)).toEqual({ "--list-gutter": "4ch" });
    expect(orderedListGutterStyle(3, -5)).toBeUndefined();
  });

  it("treats a missing/zero item count as a single item", () => {
    expect(orderedListGutterStyle(0, undefined)).toBeUndefined();
    expect(orderedListGutterStyle(0, 100)).toEqual({ "--list-gutter": "4ch" });
  });
});

describe("ChatMarkdown rich formatting", () => {
  it("renders bot assistant artifacts", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={[
          "| File | State |",
          "| --- | --- |",
          "| src/output.ts | Ready |",
          "",
          "- [x] Render table",
          "- [ ] Review diff",
          "",
          "```diff",
          "-const state = 'plain';",
          "+const state = 'rich';",
          "```",
          "",
          '```ts title="src/generated.ts"',
          "export const ready = true;",
          "```",
        ].join("\n")}
      />,
    );

    expect(html).toContain("chat-markdown-table-container");
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html.match(/readOnly=""/g)).toHaveLength(2);
    expect(html).toContain('data-language="diff"');
    expect(html).toContain('data-language="ts"');
    expect(html).toContain("src/generated.ts");
  });

  it("renders inline and display math", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd={undefined}
        text={"Inline $E = mc^2$ and display:\n\n$$\n\\sum_{n=1}^N n\n$$"}
      />,
    );

    expect(html).toContain("<math");
    expect(html).toContain('display="block"');
  });

  it("reserves Mermaid fences for client-side diagrams", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown cwd={undefined} text={"```mermaid\ngraph LR\n  A --> B\n```"} />,
    );

    expect(html).toContain('data-mermaid-diagram=""');
    expect(html).toContain("Rendering diagram");
    expect(html).not.toContain("chat-markdown-codeblock");
  });
});

describe("ChatMarkdown Windows file links", () => {
  const environmentId = EnvironmentId.make("env-windows");

  it.each([true, false])("preserves drive paths with parseRawHtml=%s", (parseRawHtml) => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="C:/Users/shawn/project"
        environmentId={environmentId}
        text="[Open](C:/Users/shawn/project/src/main.ts)"
        lineBreaks={!parseRawHtml}
        parseRawHtml={parseRawHtml}
      />,
    );

    expect(html).toContain('href="C:/Users/shawn/project/src/main.ts"');
    expect(html).toContain("chat-markdown-file-link");
  });

  it.each([true, false])("normalizes backslashes with parseRawHtml=%s", (parseRawHtml) => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="C:/Users/shawn/project"
        environmentId={environmentId}
        text={String.raw`[Open](C:\Users\shawn\project\src\main.ts)`}
        lineBreaks={!parseRawHtml}
        parseRawHtml={parseRawHtml}
      />,
    );

    expect(html).toContain('href="C:/Users/shawn/project/src/main.ts"');
    expect(html).toContain("chat-markdown-file-link");
  });

  it.each([true, false])(
    "distinguishes same-named backslash paths with parseRawHtml=%s",
    (parseRawHtml) => {
      const html = renderToStaticMarkup(
        <ChatMarkdown
          cwd="C:/Users/shawn/project"
          environmentId={environmentId}
          text={String.raw`[Source](C:\Users\shawn\project\src\index.ts) and [Test](C:\Users\shawn\project\test\index.ts)`}
          lineBreaks={!parseRawHtml}
          parseRawHtml={parseRawHtml}
        />,
      );

      expect(html).toContain("index.ts · project/src");
      expect(html).toContain("index.ts · project/test");
    },
  );

  it.each([true, false])(
    "does not disambiguate the same file in links and inline code with parseRawHtml=%s",
    (parseRawHtml) => {
      const path = String.raw`C:\Users\shawn\project\src\main.ts`;
      const html = renderToStaticMarkup(
        <ChatMarkdown
          cwd="C:/Users/shawn/project"
          environmentId={environmentId}
          text={`[Source](${path}) and \`${path}\``}
          lineBreaks={!parseRawHtml}
          parseRawHtml={parseRawHtml}
        />,
      );

      expect(html.match(/chat-markdown-file-link/g)).toHaveLength(2);
      expect(html).not.toContain("main.ts ·");
    },
  );

  it.each([true, false])("preserves reference links with parseRawHtml=%s", (parseRawHtml) => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="C:/Users/shawn/project"
        environmentId={environmentId}
        text={"[Open][source]\n\n[source]: C:/Users/shawn/project/src/main.ts"}
        lineBreaks={!parseRawHtml}
        parseRawHtml={parseRawHtml}
      />,
    );

    expect(html).toContain('href="C:/Users/shawn/project/src/main.ts"');
    expect(html).toContain("chat-markdown-file-link");
  });

  it.each([true, false])("still rejects unsafe schemes with parseRawHtml=%s", (parseRawHtml) => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="C:/Users/shawn/project"
        environmentId={environmentId}
        text="[unsafe](javascript:alert(1)) and [unknown](d:alert(1))"
        lineBreaks={!parseRawHtml}
        parseRawHtml={parseRawHtml}
      />,
    );

    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("d:alert");
    expect(html).not.toContain("chat-markdown-file-link");
  });
});

// Bot chat renders settled answers with the same props BotThreadLanding passes;
// the coding chat also streams through `isStreaming`. Every form must render
// the same markup on reload and while streaming a settled prefix.
describe("ChatMarkdown bot chat forms", () => {
  const render = (text: string, isStreaming = false) =>
    renderToStaticMarkup(<ChatMarkdown cwd="/tmp/project" text={text} isStreaming={isStreaming} />);

  const TABLE = ["| File | State |", "| --- | --- |", "| src/output.ts | Ready |"].join("\n");
  const CHECKLIST = ["- [x] Render table", "- [ ] Review diff", "- [ ] Ship"].join("\n");
  const DIFF = [
    "```diff",
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,2 +1,2 @@",
    " import { run } from './run';",
    "-run(1);",
    "+run(2);",
    "```",
  ].join("\n");
  const ALL_FORMS = [
    "Summary with a [docs link](https://example.com/docs) and [Voice settings](grokbot://app/v1/settings?id=voice).",
    "",
    TABLE,
    "",
    CHECKLIST,
    "",
    DIFF,
    "",
    '```ts title="src/generated.ts"',
    "export const ready = true;",
    "```",
    "",
    "See [output](/tmp/project/src/output.ts).",
    "",
  ].join("\n");

  it("renders tables in a scroll container with header cells", () => {
    const html = render(TABLE);
    expect(html).toContain("chat-markdown-table-container");
    expect(html.match(/<th[ >]/g)).toHaveLength(2);
    expect(html).toContain("src/output.ts");
  });

  it("renders checklists read-only with a static progress summary", () => {
    const html = render(CHECKLIST);
    expect(html.match(/type="checkbox"/g)).toHaveLength(3);
    expect(html.match(/readOnly=""/g)).toHaveLength(3);
    expect(html).toContain('data-task-progress="1/3"');
    expect(html).toContain("1 of 3 done");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="1"');
    expect(html).not.toMatch(/transition|animate-/);
  });

  it("summarizes only the outer list of a nested checklist", () => {
    const html = render(
      ["- [x] Outer one", "  - [x] Inner one", "  - [ ] Inner two", "- [ ] Outer two"].join("\n"),
    );
    expect(html.match(/data-task-progress=/g)).toHaveLength(1);
    expect(html).toContain('data-task-progress="1/2"');
  });

  it("skips the progress summary for a single task or a plain list", () => {
    expect(render("- [x] Only task")).not.toContain("data-task-progress");
    expect(render("- one\n- two")).not.toContain("data-task-progress");
  });

  it("renders diffs as a change card with line tints and counts", () => {
    const html = render(DIFF);
    expect(html).toContain('data-language="diff"');
    expect(html).toContain("chat-markdown-diff");
    expect(html.match(/data-diff-line="add"/g)).toHaveLength(1);
    expect(html.match(/data-diff-line="remove"/g)).toHaveLength(1);
    expect(html.match(/data-diff-line="hunk"/g)).toHaveLength(1);
    expect(html.match(/data-diff-line="meta"/g)).toHaveLength(3);
    expect(html).toContain("src/app.ts");
    expect(html).toContain('aria-label="1 additions, 1 deletions"');
  });

  it("titles multi-file and patch fences", () => {
    const html = render(
      [
        "```patch",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "--- a/b.ts",
        "+++ b/b.ts",
        "@@ -1 +1 @@",
        "-c",
        "+d",
        "```",
      ].join("\n"),
    );
    expect(html).toContain('data-language="patch"');
    expect(html).toContain("2 files");
    expect(html).toContain('aria-label="2 additions, 2 deletions"');
  });

  it("renders file references as titled code cards and file chips", () => {
    const html = render(ALL_FORMS);
    expect(html).toContain('data-language="ts"');
    expect(html).toContain("src/generated.ts");
    expect(html).toContain("chat-markdown-file-link");
    expect(html).toContain("output.ts");
  });

  it("renders external links and Settings chips", () => {
    const html = render(ALL_FORMS);
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain("chat-markdown-settings-link");
    expect(html).toContain("Open Settings &gt; Voice");
  });

  it.each([
    ["channels", "Bot channels"],
    ["browser", "Browser"],
    ["plugins", "Plugins"],
    ["sandbox", "Sandbox"],
    ["privacy", "Privacy"],
  ])("renders a Settings chip for %s", (id, label) => {
    const html = render(`[Open](grokbot://app/v1/settings?id=${id})`);
    expect(html).toContain("chat-markdown-settings-link");
    expect(html).toContain(`Open Settings &gt; ${label}`);
  });

  it.each([
    ["a wrong host", "grokbot://evil/v1/settings?id=providers"],
    ["an extra query key", "grokbot://app/v1/settings?id=providers&from=chat"],
    ["an unknown id", "grokbot://app/v1/settings?id=unknown"],
  ])("renders a Settings link with %s as plain text with no link", (_case, href) => {
    const html = render(`See [Open provider settings](${href}) here.`);
    expect(html).toContain("Open provider settings");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("target=");
    expect(html).not.toContain("grokbot:");
  });

  it("renders a rejected Settings link as plain text, not an OS link", () => {
    const html = render("[Open](grokbot://app/v1/settings?id=unknown)");
    expect(html).not.toContain("chat-markdown-settings-link");
    expect(html).not.toContain('href="grokbot:');
  });

  it("re-renders identical markup from persisted text after reload", () => {
    expect(render(ALL_FORMS)).toBe(render(ALL_FORMS));
  });

  it("renders a finished stream exactly like the settled message", () => {
    expect(render(ALL_FORMS, true)).toBe(render(ALL_FORMS));
  });

  it("never renders half a table while streaming", () => {
    const [header, delimiter] = TABLE.split("\n");
    for (const partial of [
      `Intro\n\n${header?.slice(0, 8)}`,
      `Intro\n\n${header}\n`,
      `Intro\n\n${header}\n${delimiter?.slice(0, 5)}`,
    ]) {
      const html = render(partial, true);
      expect(html, partial).not.toContain("| File");
      expect(html, partial).not.toContain("<table");
      expect(html, partial).toContain("Intro");
    }
    const withRowInFlight = render(`${header}\n${delimiter}\n| src/output.ts | Rea`, true);
    expect(withRowInFlight).toContain("<table");
    expect(withRowInFlight).not.toContain("src/output.ts");
  });

  it("never renders a partial fence opener while streaming", () => {
    for (const partial of ["Intro\n`", "Intro\n``", "Intro\n```", "Intro\n```di"]) {
      const html = render(partial, true);
      expect(html, partial).not.toContain("data-language");
      expect(html, partial).not.toMatch(/>[^<]*`/);
    }
    expect(render("Intro\n```diff\n+run(2);", true)).toContain('data-diff-line="add"');
  });

  it("never renders a partial task marker or setext heading while streaming", () => {
    for (const partial of ["- [x] Done\n- [", "- [x] Done\n- [ ]", "- [x] Done\n-"]) {
      const html = render(partial, true);
      expect(html.match(/type="checkbox"/g), partial).toHaveLength(1);
      // No bracket in rendered text; class names may contain brackets.
      expect(html, partial).not.toMatch(/>[^<]*\[/);
    }
    expect(render("Almost done\n-", true)).not.toContain("<h2");
  });

  it("keeps already streamed diff lines unchanged as the fence grows", () => {
    const settled = render(DIFF);
    const lines = DIFF.split("\n");
    for (let count = 2; count < lines.length - 1; count += 1) {
      const streamed = render(`${lines.slice(0, count).join("\n")}\n`, true);
      const kinds = [...streamed.matchAll(/data-diff-line="(\w+)"/g)].map((match) => match[1]);
      const settledKinds = [...settled.matchAll(/data-diff-line="(\w+)"/g)].map(
        (match) => match[1],
      );
      expect(kinds).toEqual(settledKinds.slice(0, kinds.length));
      expect(kinds).toHaveLength(count - 1);
    }
  });
});
