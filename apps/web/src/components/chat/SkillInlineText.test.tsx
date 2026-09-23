import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  CHAT_INLINE_SKILL_CHIP_CLASS_NAME,
  INLINE_SKILL_CHIP_ICON_CLASS_NAME,
} from "../composerInlineChip";
import { SkillInlineText } from "./SkillInlineText";

const skills = [
  { name: "review-follow-up", displayName: "Review Follow-up", icon: "🔧" },
  { name: "deploy", icon: "/icons/deploy.png" },
];

describe("SkillInlineText", () => {
  it("renders sent skills as the borderless composer pill", () => {
    const markup = renderToStaticMarkup(
      <SkillInlineText text="Run $review-follow-up then $deploy" skills={skills} />,
    );

    expect(markup).toContain('data-markdown-copy="$review-follow-up"');
    expect(markup).toContain('data-markdown-copy="$deploy"');
    expect(markup).not.toContain("border");
    expect(markup).toContain(CHAT_INLINE_SKILL_CHIP_CLASS_NAME);
  });

  it("gives emoji and fallback icons the same box", () => {
    const markup = renderToStaticMarkup(
      <SkillInlineText text="$review-follow-up $deploy" skills={skills} />,
    );
    const iconClass = INLINE_SKILL_CHIP_ICON_CLASS_NAME.replaceAll("&", "&amp;").replaceAll(
      ">",
      "&gt;",
    );
    const emojiIcon = `<span aria-hidden="true" class="${iconClass}">🔧</span>`;
    const fallbackIcon = `<span aria-hidden="true" class="${iconClass}"><svg`;

    expect(markup).toContain(emojiIcon);
    expect(markup).toContain(fallbackIcon);
    expect(markup).not.toContain("/icons/deploy.png");
  });
});
