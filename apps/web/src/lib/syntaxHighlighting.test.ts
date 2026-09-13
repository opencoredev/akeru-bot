import type { DiffsHighlighter } from "@pierre/diffs";
import { expect, it, vi } from "vite-plus/test";

const { getSharedHighlighter } = vi.hoisted(() => ({
  getSharedHighlighter: vi.fn(),
}));

vi.mock("@pierre/diffs", () => ({
  getSharedHighlighter,
}));

import { getSyntaxHighlighterPromise, PREFERRED_HIGHLIGHTER } from "./syntaxHighlighting";

it("prefers the Oniguruma WASM highlighter", () => {
  expect(PREFERRED_HIGHLIGHTER).toBe("shiki-wasm");
});

it("caches the recovered text highlighter for unsupported languages", async () => {
  const textHighlighter = {} as DiffsHighlighter;
  getSharedHighlighter.mockImplementation(({ langs }: { langs: string[] }) =>
    langs[0] === "text"
      ? Promise.resolve(textHighlighter)
      : Promise.reject(new Error("unsupported language")),
  );

  const first = getSyntaxHighlighterPromise("unsupported-test-language");
  await expect(first).resolves.toBe(textHighlighter);
  const second = getSyntaxHighlighterPromise("unsupported-test-language");

  expect(second).toBe(first);
  expect(getSharedHighlighter).toHaveBeenCalledTimes(2);
  expect(getSharedHighlighter).toHaveBeenCalledWith(
    expect.objectContaining({ preferredHighlighter: "shiki-wasm" }),
  );
});
