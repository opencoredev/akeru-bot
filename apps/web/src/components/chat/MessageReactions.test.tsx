import type { OrchestrationMessageReaction } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { MessageReactions } from "./MessageReactions";

const reaction = (emoji: string, personId: string): OrchestrationMessageReaction =>
  ({ emoji, personId }) as OrchestrationMessageReaction;

describe("MessageReactions", () => {
  it("renders nothing without reactions", () => {
    expect(renderToStaticMarkup(<MessageReactions reactions={[]} />)).toBe("");
  });

  it("makes your own supported reaction removable", () => {
    const markup = renderToStaticMarkup(
      <MessageReactions
        reactions={[reaction("👍", "person-1")]}
        selectedEmoji="👍"
        onToggle={vi.fn()}
      />,
    );

    expect(markup).toContain("<button");
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("Remove your 👍 reaction");
  });

  it("offers a supported reaction someone else left as one you can add", () => {
    const markup = renderToStaticMarkup(
      <MessageReactions reactions={[reaction("🎉", "person-2")]} onToggle={vi.fn()} />,
    );

    expect(markup).toContain("<button");
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain("React 🎉");
  });

  it("leaves an emoji this client cannot send as plain text, not a dead button", () => {
    const markup = renderToStaticMarkup(
      <MessageReactions reactions={[reaction("🦑", "person-2")]} onToggle={vi.fn()} />,
    );

    expect(markup).not.toContain("<button");
    expect(markup).toContain('data-reaction-emoji="🦑"');
    expect(markup).toContain("🦑");
  });

  it("stays non-interactive everywhere when the caller offers no toggle", () => {
    const markup = renderToStaticMarkup(
      <MessageReactions reactions={[reaction("👍", "person-1")]} selectedEmoji="👍" />,
    );

    expect(markup).not.toContain("<button");
    expect(markup).toContain('data-reaction-emoji="👍"');
  });

  it("counts repeats of one emoji into a single chip", () => {
    const markup = renderToStaticMarkup(
      <MessageReactions
        reactions={[reaction("👍", "person-1"), reaction("👍", "person-2")]}
        onToggle={vi.fn()}
      />,
    );

    expect((markup.match(/data-reaction-emoji/g) ?? []).length).toBe(1);
    expect(markup).toContain("👍 2");
  });
});
