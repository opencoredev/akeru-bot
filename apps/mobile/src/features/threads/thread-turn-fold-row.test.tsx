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

function entry(label: string) {
  return {
    type: "turn-fold" as const,
    id: "turn-fold:turn-1",
    createdAt: "2026-04-01T00:00:00Z",
    turnId: TurnId.make("turn-1"),
    expanded: false,
    label,
  };
}

describe("mobile turn fold labels", () => {
  it.each(["Worked for 17s", "Worked", "You stopped after 17s", "You stopped this response"])(
    "preserves %s when the locale changes with the same feed entry",
    (label) => {
      const fold = entry(label);

      const render = () =>
        renderToStaticMarkup(
          <ThreadTurnFoldRow entry={fold} onToggle={() => {}} iconColor="gray" />,
        );

      expect(render()).toContain(`>${label}</span>`);
      expect(render()).toContain("border-work-fold-separator");
      state.locale = "zh-CN";
      expect(render()).toContain(`>${label}</span>`);
    },
  );
});
