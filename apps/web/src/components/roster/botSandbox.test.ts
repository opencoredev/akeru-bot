import { describe, expect, it } from "vite-plus/test";

import { BOT_SANDBOX_OPTIONS, botSandboxChoice, botSandboxLabel } from "./botSandbox";

describe("botSandbox", () => {
  it("treats a missing bot sandbox as local", () => {
    expect(botSandboxChoice(null)).toBe("local");
    expect(botSandboxChoice("local")).toBe("local");
    expect(botSandboxChoice("vercel")).toBe("vercel");
  });

  it("lists the first sandbox providers", () => {
    expect(BOT_SANDBOX_OPTIONS.map((option) => option.value)).toEqual([
      "local",
      "e2b",
      "daytona",
      "vercel",
      "upstash",
    ]);
    expect(botSandboxLabel("vercel")).toBe("Vercel Sandbox");
  });
});
