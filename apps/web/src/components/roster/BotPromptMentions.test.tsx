import type { EnvironmentId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  BotPromptMentionChips,
  BotPromptMentionMenu,
  draftHasMentionChips,
} from "./BotPromptMentions";

function renderMenu(
  scope: Parameters<typeof BotPromptMentionMenu>[0]["scope"],
  bots: Parameters<typeof BotPromptMentionMenu>[0]["bots"] = [{ id: "bot-1", name: "Mika" }],
) {
  return renderToStaticMarkup(
    <BotPromptMentionMenu
      ref={null}
      listboxId="mentions"
      trigger={{ query: "", rangeStart: 0, rangeEnd: 1 }}
      scope={scope}
      bots={bots}
      onSelect={vi.fn()}
      onClose={vi.fn()}
      onActiveOptionChange={vi.fn()}
    />,
  );
}

describe("BotPromptMentionMenu", () => {
  it("renders an accessible listbox with the browser when the environment allows it", () => {
    const markup = renderMenu({
      environmentId: "environment-1" as EnvironmentId,
      threadId: null,
      projectId: null,
      cwd: null,
    });

    expect(markup).toContain('role="listbox"');
    expect(markup).toContain('id="mentions-option-0"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain("Browser");
    expect(markup).toContain("Mika");
  });

  it("hides the browser without a chat environment to gate it", () => {
    const markup = renderMenu(null);

    expect(markup).not.toContain("Browser");
    expect(markup).toContain("Mika");
  });
});

describe("BotPromptMentionMenu namesakes", () => {
  it("shows both bots named Mika with the role that tells them apart", () => {
    const markup = renderMenu(null, [
      { id: "bot-1", name: "Mika", title: "Designer" },
      { id: "bot-2", name: "Mika", title: "Reviewer" },
    ]);

    expect(markup.match(/role="option"/g)).toHaveLength(2);
    expect(markup).toContain("Designer");
    expect(markup).toContain("Reviewer");
  });
});

describe("BotPromptMentionChips", () => {
  it("shows a removable chip per mention", () => {
    const markup = renderToStaticMarkup(
      <BotPromptMentionChips
        draft="use @browser and @chat:thread-9 with @bot:bot-2 "
        bots={[{ id: "bot-2", name: "Mika" }]}
        onRemove={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Remove Browser"');
    expect(markup).toContain('aria-label="Remove Unknown chat"');
    expect(markup).toContain('aria-label="Remove Mika"');
  });

  it("mounts only for drafts that carry a browser or chat mention", () => {
    expect(draftHasMentionChips("hello @browser")).toBe(true);
    expect(draftHasMentionChips("see @chat:abc")).toBe(true);
    expect(draftHasMentionChips("ask @bot:bot-2")).toBe(true);
    expect(draftHasMentionChips("mail me@browser.dev")).toBe(false);
    expect(draftHasMentionChips("hello @Mika")).toBe(false);
  });
});
