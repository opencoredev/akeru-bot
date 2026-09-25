import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ setStringAsync: vi.fn() }));

vi.mock("expo-clipboard", () => ({ setStringAsync: mocks.setStringAsync }));

import { copySignInCode } from "./copySignInCode";

describe("copySignInCode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports a successful copy", async () => {
    mocks.setStringAsync.mockResolvedValue(true);
    await expect(copySignInCode("ABCD-1234")).resolves.toBe(true);
    expect(mocks.setStringAsync).toHaveBeenCalledWith("ABCD-1234");
  });

  it("reports a clipboard failure instead of rejecting", async () => {
    mocks.setStringAsync.mockRejectedValue(new Error("clipboard unavailable"));
    await expect(copySignInCode("ABCD-1234")).resolves.toBe(false);
  });
});
