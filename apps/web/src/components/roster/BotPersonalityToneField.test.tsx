import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { BotPersonalityToneField } from "./BotPersonalityToneField";
import { resolveBotPersonalityToneBand } from "./botPersonalityTone";

/** React escapes apostrophes in text nodes, so compare against escaped copy. */
function asRendered(text: string) {
  return text.replaceAll("'", "&#x27;");
}

const bot = {
  name: "Akeru",
  avatar: { kind: "blob", shape: "circle", color: "#5B7FD4" },
} as const;

function render(tone: number) {
  return renderToStaticMarkup(
    <BotPersonalityToneField bot={bot} tone={tone} onToneChange={() => {}} />,
  );
}

describe("BotPersonalityToneField", () => {
  it("offers exactly three personality choices", () => {
    const markup = render(50);
    expect(markup).toContain("Balanced");
    expect(markup).toContain("Chill");
    expect(markup).toContain("Professional");
    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain('aria-label="Personality for Akeru"');
    expect(markup.match(/role="radio"/gu)).toHaveLength(3);
    expect(markup.match(/aria-checked="true"/gu)).toHaveLength(1);
    expect(markup).not.toContain('type="range"');
  });

  it("swaps the illustrative reply as the value moves across bands", () => {
    const chill = render(0);
    const professional = render(100);

    expect(chill).toContain(asRendered(resolveBotPersonalityToneBand(0).sample));
    expect(professional).toContain(asRendered(resolveBotPersonalityToneBand(100).sample));
    expect(chill).not.toContain(asRendered(resolveBotPersonalityToneBand(100).sample));
    expect(professional).not.toContain(asRendered(resolveBotPersonalityToneBand(0).sample));
  });

  it("marks the preview as an illustration rather than a live reply", () => {
    const markup = render(50);
    expect(markup).toContain('data-testid="bot-personality-tone-preview"');
    expect(markup).toContain("An illustration of the band, not a live reply.");
    expect(markup).toContain("How Akeru might sound");
  });

  it("treats a bot saved before the field existed as balanced", () => {
    const markup = renderToStaticMarkup(
      <BotPersonalityToneField
        bot={bot}
        tone={undefined as unknown as number}
        onToneChange={() => {}}
      />,
    );
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain(asRendered(resolveBotPersonalityToneBand(50).sample));
  });

  it("maps an older in-between value to the nearest visible mode", () => {
    const markup = render(75);
    expect(markup).toContain(asRendered(resolveBotPersonalityToneBand(100).sample));
    expect(markup).not.toContain(asRendered(resolveBotPersonalityToneBand(75).sample));
  });

  it("does not fire its change callback just by rendering", () => {
    const onToneChange = vi.fn();
    renderToStaticMarkup(
      <BotPersonalityToneField bot={bot} tone={35} onToneChange={onToneChange} />,
    );
    expect(onToneChange).not.toHaveBeenCalled();
  });
});
