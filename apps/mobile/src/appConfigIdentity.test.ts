import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

describe("mobile release ownership", () => {
  it("requires Akeru-owned signing and Expo settings", () => {
    const config = NodeFS.readFileSync(
      NodePath.resolve(import.meta.dirname, "../app.config.ts"),
      "utf8",
    );

    expect(config).toContain("AKERU_APPLE_TEAM_ID");
    expect(config).toContain("AKERU_EXPO_PROJECT_ID");
    expect(config).toContain("AKERU_EXPO_OWNER");
    expect(config).toContain("{ enabled: false }");
    expect(config).not.toContain("ARK85ZXQ4Z");
    expect(config).not.toContain("d763fcb8-d37c-41ea-a773-b54a0ab4a454");
    expect(config).not.toContain('owner: "pingdotgg"');
  });
});
