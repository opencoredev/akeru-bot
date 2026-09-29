import { collectComposerMentionDisplays } from "@t3tools/shared/composerInlineTokens";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Image: { resolveAssetSource: () => ({ uri: "icon" }) },
  Linking: { openURL: vi.fn() },
  useColorScheme: () => "light",
}));
vi.mock("../../../modules/t3-markdown-text/src/MarkdownTextPrimitive", () => ({
  MarkdownTextPrimitive: "t3-text",
}));
vi.mock("../../../modules/t3-markdown-text/src/markdownFileIcons", () => ({
  markdownFileIconSource: () => 0,
}));
vi.mock("../../state/entities", () => ({ useThreadTitles: () => new Map() }));
vi.mock("../../state/bots", () => ({ useBotNames: () => new Map() }));

import { decorateSkillRuns } from "../../../modules/t3-markdown-text/src/nativeMarkdownText";
import { NativeMarkdownSelectableText } from "../../../modules/t3-markdown-text/src/NativeMarkdownSelectableText.ios";
import { labelSentMessageMentions, sentMessageMentionSkills } from "./sentMessageMentions";

const text = "check @chat:thread-9 and @chat:gone with @browser and $review";
const displays = collectComposerMentionDisplays(text, (threadId) =>
  threadId === "thread-9" ? "Release plan" : null,
);
const textStyle = {
  color: "#000",
  strongColor: "#000",
  mutedColor: "#666",
  linkColor: "#00f",
  inlineCodeColor: "#000",
  codeColor: "#000",
  codeBackgroundColor: "#eee",
  codeBlockBackgroundColor: "#eee",
  fileTextColor: "#000",
  skillTextColor: "#0a0",
  quoteMarkerColor: "#999",
  dividerColor: "#ccc",
  fontSize: 15,
  lineHeight: 22,
  fontFamily: "body",
  headingFontFamily: "heading",
  boldFontFamily: "bold",
};

describe("sent message mentions", () => {
  it("renders browser, known chat, and unknown chat mentions as chips beside skills", () => {
    const skills = sentMessageMentionSkills(displays, [{ name: "review", displayName: "Review" }]);
    const runs = decorateSkillRuns([{ text }], skills);
    const element = NativeMarkdownSelectableText({ runs, textStyle });
    const tree = JSON.stringify(element);
    const shown = (element.props.children as Array<{ props: { children: string } }>)
      .map((child) => child.props.children)
      .join("");

    expect(tree).toContain("￼ Release plan");
    expect(tree).toContain("￼ Unknown chat");
    expect(tree).toContain("￼ Browser");
    expect(tree).toContain("￼ Review");
    expect(tree).toContain("t3-skill:sf:text.bubble");
    expect(tree).toContain("t3-skill:sf:globe");
    expect(tree).toContain("t3-skill:sf:cube");
    expect(shown).not.toContain("@chat:");
    expect(shown).not.toContain("@browser");
    // Each chip run keeps its raw token, which is what the copy button copies.
    expect(runs.filter((run) => run.skillLabel).map((run) => run.text)).toEqual([
      "@chat:thread-9",
      "@chat:gone",
      "@browser",
      "$review",
    ]);
  });

  it("labels an exact-bot mention with the bot's name and a person icon", () => {
    const botDisplays = collectComposerMentionDisplays(
      "ask @bot:bot-2 and @bot:gone",
      () => null,
      (botId) => (botId === "bot-2" ? "Mika" : null),
    );
    const skills = sentMessageMentionSkills(botDisplays, []);
    expect(skills.map((skill) => [skill.token, skill.displayName, skill.icon])).toEqual([
      ["@bot:bot-2", "Mika", "person.crop.circle"],
      ["@bot:gone", "Unknown bot", "person.crop.circle"],
    ]);
  });

  it("labels mentions in the plain markdown fallback", () => {
    expect(labelSentMessageMentions(text, displays)).toBe(
      "check **Release plan** and **Unknown chat** with **Browser** and $review",
    );
    expect(labelSentMessageMentions("no mentions", [])).toBe("no mentions");
    expect(
      labelSentMessageMentions("use @browser\n```\nrun @browser\n```\nand `@browser`", displays),
    ).toBe("use **Browser**\n```\nrun @browser\n```\nand `@browser`");
  });
});
