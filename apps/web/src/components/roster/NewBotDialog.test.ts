// @effect-diagnostics nodeBuiltinImport:off - These guards inspect the dialog source.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

describe("NewBotDialog", () => {
  const source = NodeFS.readFileSync(new URL("./NewBotDialog.tsx", import.meta.url), "utf8");

  it("identifies the name as required and explains why creation is unavailable", () => {
    expect(source).toContain("required");
    expect(source).toContain('aria-describedby="new-bot-name-help"');
    expect(source).toContain("Enter a name to create this bot.");
  });

  it("makes the disabled create action visibly distinct", () => {
    expect(source).toContain("disabled:bg-muted");
    expect(source).toContain("disabled:text-muted-foreground");
    expect(source).toContain("disabled:opacity-100");
  });

  it("warns when no provider can run the new bot's default model", () => {
    expect(source).toContain("useBotEngineAvailability(null)");
    expect(source).toContain("<ProviderUnavailableNotice");
  });
});
