import { describe, expect, it } from "vite-plus/test";

import {
  BOT_SANDBOX_OPTIONS,
  DEFAULT_BOT_RUNTIME_MODE,
  botSandboxChoice,
  botSandboxLabel,
  resolveBotRuntimeMode,
} from "./botSandbox";

describe("botSandbox", () => {
  it("treats a missing bot sandbox as local", () => {
    expect(botSandboxChoice(null)).toBe("local");
    expect(botSandboxChoice("local")).toBe("local");
    expect(botSandboxChoice("vercel")).toBe("vercel");
  });

  it("asks before local tools unless full access is enabled", () => {
    expect(DEFAULT_BOT_RUNTIME_MODE).toBe("approval-required");
    expect(resolveBotRuntimeMode(null, "approval-required")).toBe("approval-required");
    expect(resolveBotRuntimeMode("local", "full-access")).toBe("full-access");
  });

  it("runs cloud sandbox tools without a local approval prompt", () => {
    for (const sandbox of ["vercel", "akeru-cloud", "upstash"] as const) {
      expect(resolveBotRuntimeMode(sandbox, "approval-required")).toBe("full-access");
    }
  });

  it("lists the first sandbox providers", () => {
    expect(BOT_SANDBOX_OPTIONS.map((option) => option.value)).toEqual([
      "local",
      "vercel",
      "akeru-cloud",
      "upstash",
    ]);
    expect(botSandboxLabel("akeru-cloud")).toBe("Akeru Cloud");
  });
});
