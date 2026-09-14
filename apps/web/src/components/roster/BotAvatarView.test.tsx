import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { BotAvatarView } from "./BotAvatarView";

describe("BotAvatarView", () => {
  it("renders ink-bar eyes on a blob instead of an initial", () => {
    const markup = renderToStaticMarkup(
      <BotAvatarView name="Theo" avatar={{ kind: "blob", shape: "circle", color: "#E0645C" }} />,
    );

    expect(markup).toContain('class="bot-eyes"');
    expect(markup).toContain('viewBox="-22 -18 44 36"');
    expect(markup).toContain('data-bot-state="idle"');
    expect(markup).toContain('fill="#0A0A0A"');
    expect(markup).not.toContain("</text>");
    expect(markup).not.toContain(">T</text>");
  });

  it("uses light eyes when the blob color is dark", () => {
    const markup = renderToStaticMarkup(
      <BotAvatarView name="Theo" avatar={{ kind: "blob", shape: "pill", color: "#141062" }} />,
    );

    expect(markup).toContain('fill="#FFFFFF"');
  });

  it("shortens the eyes while working", () => {
    const idle = renderToStaticMarkup(
      <BotAvatarView
        name="Akeru"
        state="idle"
        avatar={{ kind: "blob", shape: "square", color: "#5B7FD4" }}
      />,
    );
    const working = renderToStaticMarkup(
      <BotAvatarView
        name="Akeru"
        state="working"
        avatar={{ kind: "blob", shape: "square", color: "#5B7FD4" }}
      />,
    );

    expect(working).toContain('data-bot-state="working"');
    expect(working).not.toBe(idle);
  });

  it("renders a dither identicon without a face", () => {
    const markup = renderToStaticMarkup(
      <BotAvatarView name="Akeru" avatar={{ kind: "dither", seed: "akeru-seed" }} />,
    );

    expect(markup).toContain('data-avatar-dither="akeru-seed"');
    expect(markup).not.toContain("bot-eyes");
  });
});
