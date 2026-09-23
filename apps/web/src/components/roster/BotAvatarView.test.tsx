import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { BotAvatarView } from "./BotAvatarView";

describe("BotAvatarView", () => {
  it("draws a blob as a flat svg body with cutout eyes", () => {
    const markup = renderToStaticMarkup(
      <BotAvatarView name="Theo" avatar={{ kind: "blob", shape: "hex", color: "#FF4A5A" }} />,
    );

    expect(markup).toContain('data-avatar-shape="hex"');
    expect(markup).toContain('data-bot-state="idle"');
    expect(markup).toContain('fill="#FF4A5A"');
    expect(markup).toMatch(/<mask id="bot-eyes-[\w-]+"/);
    expect(markup).toMatch(/mask="url\(#bot-eyes-[\w-]+\)"/);
    expect(markup).toContain('class="bot-eyes" fill="#000"');
    expect(markup).not.toContain("<canvas");
  });

  it("gives every avatar its own mask", () => {
    const avatar = { kind: "blob", shape: "circle", color: "#2E8EFF" } as const;
    const markup = renderToStaticMarkup(
      <>
        <BotAvatarView name="A" avatar={avatar} />
        <BotAvatarView name="B" avatar={avatar} />
      </>,
    );

    const ids = [...markup.matchAll(/<mask id="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("shows retired muted presets in the current palette", () => {
    const markup = renderToStaticMarkup(
      <BotAvatarView name="Old" avatar={{ kind: "blob", shape: "hex", color: "#E0645C" }} />,
    );

    expect(markup).toContain('fill="#FF4A5A"');
    expect(markup).not.toContain("#E0645C");
  });

  it("renders the same resting face whatever the bot is doing", () => {
    const avatar = { kind: "blob", shape: "square", color: "#5B7FD4" } as const;
    const eyes = (markup: string) => [...markup.matchAll(/<rect x="-4.2"[^>]*>/g)].map((m) => m[0]);
    const idle = renderToStaticMarkup(<BotAvatarView name="Akeru" state="idle" avatar={avatar} />);
    const working = renderToStaticMarkup(
      <BotAvatarView name="Akeru" state="working" avatar={avatar} />,
    );
    const waiting = renderToStaticMarkup(
      <BotAvatarView name="Akeru" state="needs-you" avatar={avatar} />,
    );

    expect(working).toContain('data-bot-state="working"');
    expect(waiting).toContain('data-bot-state="needs-you"');
    expect(eyes(idle)).toHaveLength(2);
    expect(eyes(working)).toEqual(eyes(idle));
    expect(eyes(waiting)).toEqual(eyes(idle));
  });

  it("paints dark eyes and an outline on light bodies instead of cutting them out", () => {
    const white = renderToStaticMarkup(
      <BotAvatarView name="Dew" avatar={{ kind: "blob", shape: "drop", color: "#FFFFFF" }} />,
    );
    const blue = renderToStaticMarkup(
      <BotAvatarView name="Rin" avatar={{ kind: "blob", shape: "drop", color: "#1FBFAE" }} />,
    );

    expect(white).toContain("rgba(0, 0, 0, 0.14)");
    expect(white).toContain('class="bot-eyes" fill="#161616"');
    expect(white).not.toContain("<mask");
    expect(blue).not.toContain("rgba(0, 0, 0, 0.14)");
    expect(blue).toContain("<mask");
  });

  it("draws a legacy dither avatar as a blob", () => {
    const markup = renderToStaticMarkup(
      <BotAvatarView name="Akeru" avatar={{ kind: "dither", seed: "akeru-seed" }} />,
    );

    expect(markup).toContain("data-avatar-shape=");
    expect(markup).toContain('class="bot-eyes"');
  });
});
