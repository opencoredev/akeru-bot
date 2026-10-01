import { TurnId } from "@akeru/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ThreadTurnFoldRow } from "./thread-turn-fold-row";

const state = vi.hoisted(() => ({ locale: "en" as "en" | "zh-CN" }));

vi.mock("react-native", () => ({ Pressable: "div" }));

vi.mock("../../components/AppText", () => ({ AppText: "span" }));

vi.mock("../../components/AppSymbol", () => ({ SymbolView: "i" }));

vi.mock("../../lib/i18n", async () => {
  const { catalogRegistry, createTranslator } = await import("@akeru/client-runtime/i18n");
  const zh = await catalogRegistry["zh-CN"]!();
  const translators = { en: createTranslator("en"), "zh-CN": createTranslator("zh-CN", zh) };

  return { useMobileI18n: () => ({ t: translators[state.locale].translate }) };
});

beforeEach(() => {
  state.locale = "en";
});

function entry(interrupted: boolean, elapsedMs: number | null) {
  return {
    type: "turn-fold" as const,
    id: "turn-fold:turn-1",
    createdAt: "2026-04-01T00:00:00Z",
    turnId: TurnId.make("turn-1"),
    expanded: false,
    interrupted,
    elapsedMs,
  };
}

describe("mobile turn fold translations", () => {
  it.each([
    { interrupted: false, elapsedMs: 17_000, english: "Worked for 17s", chinese: "已工作 17秒" },
    { interrupted: false, elapsedMs: null, english: "Worked", chinese: "已工作" },
    {
      interrupted: true,
      elapsedMs: 17_000,
      english: "You stopped after 17s",
      chinese: "你在 17秒后停止了回复",
    },
    {
      interrupted: true,
      elapsedMs: null,
      english: "You stopped this response",
      chinese: "你停止了这次回复",
    },
  ])(
    "translates $english when the locale changes with the same feed entry",
    ({ interrupted, elapsedMs, english, chinese }) => {
      const fold = entry(interrupted, elapsedMs);

      const render = () =>
        renderToStaticMarkup(
          <ThreadTurnFoldRow entry={fold} onToggle={() => {}} iconColor="gray" />,
        );

      expect(render()).toContain(`>${english}</span>`);
      state.locale = "zh-CN";
      expect(render()).toContain(`>${chinese}</span>`);
    },
  );
  it.each([
    [0, "1ms"],
    [100, "100ms"],
    [1200, "1.2s"],
    [9950, "10s"],
    [61_000, "1m 1s"],
    [3_661_000, "1h 1m"],
  ])("preserves English duration formatting for %s ms", (elapsedMs, duration) => {
    expect(
      renderToStaticMarkup(
        <ThreadTurnFoldRow entry={entry(false, elapsedMs)} onToggle={() => {}} iconColor="gray" />,
      ),
    ).toContain(`>Worked for ${duration}</span>`);
  });
});
