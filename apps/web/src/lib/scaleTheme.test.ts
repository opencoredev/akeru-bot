import { assert, describe, it } from "vite-plus/test";

import { cn } from "./utils";

describe("scale theme class merging", () => {
  it.each([
    ["grid-cols-banner-row", "grid-cols-2"],
    ["grid-cols-banner-row-plain", "grid-cols-3"],
    ["pb-composer-overlap-1", "pb-0"],
    ["pb-composer-overlap-1.5", "pb-0"],
    ["-mb-composer-seam", "mb-0"],
    ["w-composer-drawer", "w-full"],
    ["ps-banner-indent", "ps-0"],
    ["max-w-banner-actions-wrapped", "max-w-full"],
    ["text-code-label", "text-sm"],
    ["rounded-0.5rem", "rounded-none"],
    ["rounded-1rem", "rounded-none"],
    ["rounded-t-16px", "rounded-t-none"],
    ["shadow-progress-glow", "shadow-none"],
    ["before:shadow-composer-banner", "before:shadow-none"],
    ["dark:before:shadow-composer-banner-dark", "dark:before:shadow-none"],
    ["bg-composer-glass", "bg-transparent"],
  ])("lets the later class win between %s and %s", (namedClass, standardClass) => {
    assert.strictEqual(cn(namedClass, standardClass), standardClass);
    assert.strictEqual(cn(standardClass, namedClass), namedClass);
  });

  it("keeps root padding on other sides when bottom padding is overridden", () => {
    assert.strictEqual(cn("p-1 pb-composer-overlap-1", "pb-0"), "p-1 pb-0");
    assert.strictEqual(cn("p-1 pb-0", "pb-composer-overlap-1"), "p-1 pb-composer-overlap-1");
  });

  it("merges named grid templates with each other", () => {
    assert.strictEqual(
      cn("grid-cols-banner-row", "grid-cols-banner-row-plain"),
      "grid-cols-banner-row-plain",
    );
    assert.strictEqual(
      cn("grid-cols-banner-row-plain", "grid-cols-banner-row"),
      "grid-cols-banner-row",
    );
  });

  it("keeps text color and font size independent", () => {
    assert.strictEqual(
      cn("text-code-label", "text-muted-foreground"),
      "text-code-label text-muted-foreground",
    );
  });
});
