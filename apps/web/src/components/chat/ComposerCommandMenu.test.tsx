import { renderToStaticMarkup } from "react-dom/server";
import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ComposerCommandMenu } from "./ComposerCommandMenu";

describe("ComposerCommandMenu", () => {
  it("renders slash-command results as an attached composer drawer", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId={null}
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain('data-composer-command-drawer="true"');
    expect(markup).toContain("chat-composer-drawer-surface");
    expect(markup).toContain("chat-composer-drawer-attached");
    expect(markup).not.toContain("dropdown-glass");
  });

  it("renders commands without a category heading or invented icons", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[
          {
            id: "slash:model",
            type: "slash-command",
            command: "model",
            label: "/model",
            description: "Switch response model for this thread",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId="slash:model"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain("/model");
    expect(markup).toContain("Switch response model for this thread");
    expect(markup).not.toContain("Built-in");
    expect(markup).not.toContain("<svg");
    expect(markup).toContain("font-sans text-xs font-medium");
    expect(markup).not.toContain("font-mono");
    expect(markup).not.toContain("grid-cols-");
    expect(markup).toContain("max-w-[45%]");
    expect(markup).toContain("text-left");
  });

  it("falls back to the skill source icon ahead of the row when the skill has none", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[
          {
            id: "skill:codex:browser",
            type: "skill",
            provider: ProviderDriverKind.make("codex"),
            skill: {
              name: "browser",
              path: "/Users/maria/.codex/plugins/browser/skills/browser/SKILL.md",
              scope: "user",
              enabled: true,
            },
            label: "Browser",
            description: "Open and control the in-app browser",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="skill"
        activeItemId="skill:codex:browser"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain("Browser");
    expect(markup).toContain('data-slot="badge"');
    expect(markup).toContain(">App Skill</span>");
    expect(markup).toContain("Open and control the in-app browser");
    expect(markup).toContain("max-w-[48ch]");
    expect(markup).toContain("text-secondary-label text-xs");
    expect(markup).toContain("ms-auto");
    expect(markup.indexOf("Open and control the in-app browser")).toBeLessThan(
      markup.indexOf(">App Skill</span>"),
    );
    expect(markup).toContain('data-skill-icon="source"');
    expect(markup).toContain("lucide-blocks");
    expect(markup.indexOf("<svg")).toBeLessThan(markup.indexOf("Browser"));
    expect(markup.indexOf("<svg")).toBeLessThan(markup.indexOf('data-slot="badge"'));
  });

  it("renders the skill's own emoji icon instead of the source glyph", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[
          {
            id: "skill:claude:review",
            type: "skill",
            provider: ProviderDriverKind.make("claudeAgent"),
            skill: {
              name: "review",
              path: "/home/maria/.claude/skills/review/SKILL.md",
              scope: "user",
              enabled: true,
              icon: "🔍",
            },
            label: "Review",
            description: "Review the current diff",
          },
          {
            id: "skill:codex:deploy",
            type: "skill",
            provider: ProviderDriverKind.make("codex"),
            skill: {
              name: "deploy",
              path: "/home/maria/.codex/skills/deploy/SKILL.md",
              scope: "user",
              enabled: true,
              icon: "/home/maria/.codex/skills/deploy/assets/icon.png",
            },
            label: "Deploy",
            description: "Ship it",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="skill"
        activeItemId="skill:claude:review"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    const [reviewRow = "", deployRow = ""] = markup.split(
      'data-composer-item-id="skill:codex:deploy"',
    );
    expect(reviewRow).toContain('<span aria-hidden="true" class="flex size-[1.6em]');
    expect(reviewRow).toContain('data-skill-icon="own">🔍</span>');
    expect(reviewRow).not.toContain("lucide-user-round");
    expect(reviewRow).toContain(">Personal Skill</span>");
    expect(deployRow).toContain('data-skill-icon="source"');
    expect(deployRow).toContain("lucide-user-round");
    expect(deployRow).not.toContain("icon.png");
  });

  it("keeps slash skills aligned with the source icon ahead of the row", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[
          {
            id: "skill:codex:ask-matt",
            type: "skill",
            provider: ProviderDriverKind.make("codex"),
            skill: {
              name: "ask-matt",
              displayName: "Ask Matt",
              path: "/skills/ask-matt/SKILL.md",
              scope: "repo",
              enabled: true,
            },
            label: "/skill:ask-matt",
            description: "Find the right skill or workflow",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId="skill:codex:ask-matt"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain('<span class="text-secondary-label">/skill:</span>Ask Matt');
    expect(markup).toContain('data-slot="badge"');
    expect(markup).toContain("lucide-folder");
    expect(markup).toContain(">Repo</span>");
    expect(markup).toContain("Find the right skill or workflow");
    expect(markup).not.toContain("font-medium text-secondary-label");
  });
});
