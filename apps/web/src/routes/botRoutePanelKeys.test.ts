// @effect-diagnostics nodeBuiltinImport:off - The route contract reads its source.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { botRoutePanelKeys } from "./botRoutePanelKeys";

describe("bot route panel keys", () => {
  it("gives sibling panels separate identities for the same bot", () => {
    const keys = botRoutePanelKeys("bot-1");

    expect(keys.thread).not.toBe(keys.details);
  });

  it("uses the separate identities for both route siblings", () => {
    const source = NodeFS.readFileSync(new URL("./_chat.bots.$botId.tsx", import.meta.url), "utf8");

    expect(source).toContain("key={panelKeys.thread}");
    expect(source).toContain("key={panelKeys.details}");
  });
});
