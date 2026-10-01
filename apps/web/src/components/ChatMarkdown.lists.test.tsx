
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));

vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));

vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));

vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));

vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  usePreparedConnection: () => ({ _tag: "Loading" }),
}));

vi.mock("../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
}));

vi.mock("../localShellAccess", () => ({
  useLocalShellAccess: () => ({ isLocal: true, isResolved: true }),
}));

vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));

import { orderedListGutter } from "./ChatMarkdown";

describe("orderedListGutter", () => {
  it("leaves the default gutter alone for single-digit lists", () => {
    expect(orderedListGutter(9, undefined)).toBeUndefined();
  });

  it("leaves the default gutter alone for two-digit lists", () => {
    expect(orderedListGutter(99, undefined)).toBeUndefined();
  });

  it("leaves the default gutter alone for a two-digit list that starts above 1", () => {
    // start=50 + 49 items => last marker is "98", still two digits.
    expect(orderedListGutter(49, 50)).toBeUndefined();
  });

  it("widens the gutter once the last marker reaches three digits", () => {
    // item 100 is the bug from #6512: a 100-item list starting at 1.
    expect(orderedListGutter(100, undefined)).toBe("4ch");
  });

  it("accounts for a non-default start attribute", () => {
    // start=95 + 9 items => last marker is "103", three digits.
    expect(orderedListGutter(9, 95)).toBe("4ch");
    expect(orderedListGutter(5, "999995")).toBe("7ch");
  });

  it("scales further for four-digit markers", () => {
    expect(orderedListGutter(1000, undefined)).toBe("5ch");
  });

  it("uses the widest marker and includes a negative start's minus sign", () => {
    expect(orderedListGutter(1001, -1000)).toBe("6ch");
    expect(orderedListGutter(3, -15)).toBe("4ch");
    expect(orderedListGutter(3, -5)).toBeUndefined();
  });

  it("treats a missing/zero item count as a single item", () => {
    expect(orderedListGutter(0, undefined)).toBeUndefined();
    expect(orderedListGutter(0, 100)).toBe("4ch");
  });
});
