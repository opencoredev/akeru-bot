import { describe, expect, it } from "vite-plus/test";

import {
  formatProviderSkillDisplayName,
  getProviderSlashCommandsForSlashMenu,
  getProviderSkillsForSlashMenu,
  resolveProviderSkillSourceKind,
  resolveProviderSkillTextIcon,
} from "./providerSkills.ts";

describe("formatProviderSkillDisplayName", () => {
  it("prefers the provider display name", () => {
    expect(
      formatProviderSkillDisplayName({
        name: "review-follow-up",
        displayName: "Review Follow-up",
      }),
    ).toBe("Review Follow-up");
  });

  it("falls back to a title-cased skill name", () => {
    expect(
      formatProviderSkillDisplayName({
        name: "review-follow-up",
      }),
    ).toBe("Review Follow Up");
  });
});

describe("getProviderSkillsForSlashMenu", () => {
  it("keeps the skill alias when the provider also exposes it as a slash command", () => {
    const askMatt = {
      name: "ask-matt",
      path: "/Users/matt/.agents/skills/ask-matt/SKILL.md",
      enabled: true,
    };
    expect(getProviderSkillsForSlashMenu([askMatt], true).map((skill) => skill.name)).toEqual([
      "ask-matt",
    ]);
  });
});

describe("getProviderSlashCommandsForSlashMenu", () => {
  const commands = [
    { name: "ask-matt", description: "Ask which skill fits your situation." },
    { name: "compact", description: "Compact the conversation." },
  ];
  const skills = [
    {
      name: "ask-matt",
      path: "/Users/matt/.agents/skills/ask-matt/SKILL.md",
      enabled: true,
    },
  ];

  it("lets the skill alias win when a provider command has the same name", () => {
    expect(
      getProviderSlashCommandsForSlashMenu(commands, skills).map((command) => command.name),
    ).toEqual(["compact"]);
  });

  it("keeps the provider command when the matching skill alias is hidden", () => {
    const visibleSkills = getProviderSkillsForSlashMenu(skills, false);

    expect(
      getProviderSlashCommandsForSlashMenu(commands, visibleSkills).map((command) => command.name),
    ).toEqual(["ask-matt", "compact"]);
  });
});

describe("resolveProviderSkillSourceKind", () => {
  it("marks plugin-backed skills as app installs", () => {
    expect(
      resolveProviderSkillSourceKind({
        path: "/Users/julius/.codex/plugins/cache/openai-curated/github/skills/gh-fix-ci/SKILL.md",
        scope: "user",
      }),
    ).toBe("app");
  });

  it("maps standard scopes to source kinds", () => {
    expect(
      resolveProviderSkillSourceKind({
        path: "/workspace/.codex/skills/review-follow-up/SKILL.md",
        scope: "repo",
      }),
    ).toBe("repo");
    expect(
      resolveProviderSkillSourceKind({
        path: "/workspace/.codex/skills/review-follow-up/SKILL.md",
        scope: "project",
      }),
    ).toBe("project");
    expect(
      resolveProviderSkillSourceKind({
        path: "/Users/julius/.agents/skills/agent-browser/SKILL.md",
        scope: "user",
      }),
    ).toBe("personal");
    expect(
      resolveProviderSkillSourceKind({
        path: "/usr/local/share/codex/skills/imagegen/SKILL.md",
        scope: "system",
      }),
    ).toBe("system");
  });

  it("keeps unknown and missing scopes usable", () => {
    expect(
      resolveProviderSkillSourceKind({
        path: "/opt/skills/team-review/SKILL.md",
        scope: "team_shared",
      }),
    ).toBe("other");
    expect(
      resolveProviderSkillSourceKind({
        path: "/opt/skills/team-review/SKILL.md",
      }),
    ).toBe("other");
  });
});

describe("resolveProviderSkillTextIcon", () => {
  it.each([
    ["a single emoji", "🔧"],
    ["a pictographic symbol", "★"],
    ["an emoji with a variation selector", "❤️"],
    ["a skin-tone modifier", "👍🏽"],
    ["a ZWJ sequence", "🧑‍💻"],
    ["a ZWJ sequence with selector and modifier", "🏳️‍🌈"],
    ["a regional-indicator flag", "🇯🇵"],
    ["a subdivision tag flag", "🏴󠁧󠁢󠁥󠁮󠁧󠁿"],
    ["a digit keycap", "1️⃣"],
    ["a hash keycap", "#️⃣"],
    ["an asterisk keycap", "*️⃣"],
  ])("accepts %s", (_label, icon) => {
    expect(resolveProviderSkillTextIcon({ icon })).toBe(icon);
  });

  it("strips surrounding spaces", () => {
    expect(resolveProviderSkillTextIcon({ icon: " 🧑‍💻 " })).toBe("🧑‍💻");
  });

  it.each([
    ["a missing icon", undefined],
    ["a named glyph", "wrench"],
    ["an absolute asset path", "/icons/small.png"],
    ["a relative asset path", "./assets/icon.svg"],
    ["a bare digit", "1"],
    ["multi-glyph text", "あいう"],
    ["several emoji", "🔧🔨"],
    ["a bidi embedding", "‪🔧"],
    ["a bidi override", "‮‮"],
    ["a bidi isolate", "🔧⁦"],
    ["a left-to-right mark", "‎🔧"],
    ["a right-to-left mark", "🔧‏"],
    ["a C0 control", "🔧\u0007"],
    ["a C1 control", "\u0085"],
    ["a line separator", "🔧 "],
    ["a paragraph separator", " "],
    ["a zero-width space", "🔧​"],
    ["a word joiner", "⁠🔧"],
    ["a trailing ZWJ", "🔧‍"],
    ["a ZWJ joining non-emoji", "a‍b"],
  ])("rejects %s", (_label, icon) => {
    expect(resolveProviderSkillTextIcon(icon === undefined ? {} : { icon })).toBeNull();
  });
});
