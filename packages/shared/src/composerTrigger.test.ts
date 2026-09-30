import { describe, expect, it } from "vite-plus/test";

import {
  detectComposerTrigger,
  serializeComposerFileLink,
  serializeComposerMentionPath,
} from "./composerTrigger.ts";

describe("serializeComposerMentionPath", () => {
  it("keeps simple mention paths unquoted", () => {
    expect(serializeComposerMentionPath("src/index.ts")).toBe("src/index.ts");
  });

  it("quotes mention paths containing whitespace", () => {
    expect(serializeComposerMentionPath("docs/My File.md")).toBe('"docs/My File.md"');
  });

  it("escapes quoted mention path content", () => {
    expect(serializeComposerMentionPath('docs/My "File".md')).toBe('"docs/My \\"File\\".md"');
  });
});

describe("serializeComposerFileLink", () => {
  it("uses the basename as the markdown label", () => {
    expect(serializeComposerFileLink("path/to/package.json")).toBe(
      "[package.json](path/to/package.json)",
    );
  });

  it("encodes markdown-sensitive destination characters", () => {
    expect(serializeComposerFileLink("docs/My File (draft).md")).toBe(
      "[My File (draft).md](docs/My%20File%20%28draft%29.md)",
    );
  });

  it("supports windows paths", () => {
    expect(serializeComposerFileLink("C:\\repo\\src\\index.ts")).toBe(
      "[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)",
    );
  });

  it("preserves paths that legitimately start with an at sign", () => {
    expect(serializeComposerFileLink("@scope/package.json")).toBe(
      "[package.json](@scope/package.json)",
    );
  });
});

describe("detectComposerTrigger", () => {
  it("detects each trigger kind at the caret", () => {
    expect(detectComposerTrigger("open @bro", 9)).toMatchObject({
      kind: "path",
      query: "bro",
      rangeStart: 5,
      rangeEnd: 9,
    });
    expect(detectComposerTrigger("see @chat:rel", 15)).toMatchObject({
      kind: "path",
      query: "chat:rel",
    });
    expect(detectComposerTrigger("use $rev", 8)).toMatchObject({ kind: "skill", query: "rev" });
    expect(detectComposerTrigger("/mod", 4)).toMatchObject({ kind: "slash-command", query: "mod" });
  });

  it("stays closed for plain text and email addresses", () => {
    expect(detectComposerTrigger("hello there", 11)).toBeNull();
    expect(detectComposerTrigger("mail me@browser.dev", 19)).toBeNull();
  });
});
