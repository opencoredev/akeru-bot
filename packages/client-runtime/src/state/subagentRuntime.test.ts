import { describe, expect, it } from "@effect/vitest";

import { isBackgroundTaskActivity } from "./subagentRuntime.ts";

describe("isBackgroundTaskActivity", () => {
  it("keeps stamped agents off the ordinary work log", () => {
    expect(isBackgroundTaskActivity({ agentKind: "agent" })).toBe(false);
  });

  it.each([{}, { agentKind: "background" }, { agentKind: "unknown" }, { agentKind: null }])(
    "keeps background, legacy and unrecognized stamps in the ordinary work log: %j",
    (payload) => {
      expect(isBackgroundTaskActivity(payload)).toBe(true);
    },
  );
});
