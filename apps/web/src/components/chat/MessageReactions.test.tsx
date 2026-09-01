import { renderToStaticMarkup } from "react-dom/server";
import { BotId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { MessageReactions } from "./MessageReactions";

describe("MessageReactions", () => {
  it("groups matching emoji reactions and renders their count", () => {
    const html = renderToStaticMarkup(
      <MessageReactions
        reactions={[
          { botId: BotId.make("bot-1"), emoji: "👍" },
          { botId: BotId.make("bot-2"), emoji: "👍" },
          { botId: BotId.make("bot-1"), emoji: "🎉" },
        ]}
      />,
    );

    expect(html).toContain("👍 2");
    expect(html).toContain("🎉");
  });

  it("renders nothing without reactions", () => {
    expect(renderToStaticMarkup(<MessageReactions reactions={[]} />)).toBe("");
  });
});
