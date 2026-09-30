import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../i18n", () => ({
  availableLanguages: [{ id: "zh-CN", label: "简体中文" }],
  useI18n: () => ({
    t: (message: string) => message,
    preference: "zh-CN",
    setPreference: async () => {},
    catalogFailed: true,
    retryCatalog: () => {},
  }),
}));

import { LanguageSetting } from "./LanguageSetting";

describe("language setting catalog failure", () => {
  it("says English is showing and offers a retry", () => {
    const html = renderToStaticMarkup(<LanguageSetting />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("The selected language could not load, so English is shown.");
    expect(html).toContain("Try again");
  });
});
