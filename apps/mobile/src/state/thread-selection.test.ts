import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { resolveThreadSelectionDetailRef } from "./thread-selection";

const selectedThreadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

describe("resolveThreadSelectionDetailRef", () => {
  it("uses the empty detail target when a shell is available", () => {
    expect(resolveThreadSelectionDetailRef(selectedThreadRef, true)).toBeNull();
  });

  it("keeps the detail fallback for shell-absent deep links", () => {
    expect(resolveThreadSelectionDetailRef(selectedThreadRef, false)).toBe(selectedThreadRef);
    expect(resolveThreadSelectionDetailRef(null, false)).toBeNull();
  });
});
