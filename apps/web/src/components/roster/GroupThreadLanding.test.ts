import { describe, expect, it } from "vite-plus/test";

import { isCurrentGroupPerson } from "./roster.logic";
import { resolveAvailableGroupBoss } from "./GroupThreadLanding";

describe("group thread person placement", () => {
  it("keeps legacy host messages on the right for the host", () => {
    expect(isCurrentGroupPerson(null, "person-host", "person-host")).toBe(true);
  });

  it("puts legacy host messages on the left for a guest", () => {
    expect(isCurrentGroupPerson(null, "person-guest", "person-host")).toBe(false);
  });

  it("puts another paired person's message on the left", () => {
    expect(isCurrentGroupPerson("person-guest", "person-host", "person-host")).toBe(false);
  });
});

describe("group boss availability", () => {
  it("keeps the landing available when the configured boss is unavailable", () => {
    expect(resolveAvailableGroupBoss([{ id: "specialist" }], "boss")).toBeNull();
  });
});
