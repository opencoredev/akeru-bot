import * as NodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";

import { pickMostVisibleDemo } from "./demoPlayback";

describe("landing demo playback", () => {
  it("plays only the most visible demo", () => {
    NodeAssert.equal(pickMostVisibleDemo([0.2, 0.8, 0.4]), 1);
    NodeAssert.equal(pickMostVisibleDemo([0, 0, 0]), null);
  });

  it("keeps the first demo when visibility is tied", () => {
    NodeAssert.equal(pickMostVisibleDemo([0.6, 0.6, 0.2]), 0);
  });
});
