import { describe, expect, it } from "vite-plus/test";

import { createDeviceCodePollState } from "../deviceCode.ts";
import { pollKimiDeviceLogin, type KimiDeviceLoginPending } from "./kimi.ts";

describe("Kimi For Coding OAuth", () => {
  it("fails legacy pending logins without throwing", async () => {
    const pending = {
      deviceCode: "legacy-device-code",
      userCode: "ABCD-EFGH",
      url: "https://auth.kimi.com/device",
      instructions: "Enter code: ABCD-EFGH",
      state: createDeviceCodePollState({ intervalSeconds: 5, expiresInSeconds: 900 }),
    } as KimiDeviceLoginPending;

    await expect(pollKimiDeviceLogin(pending)).resolves.toEqual({
      status: "failed",
      error: "Kimi For Coding login is missing its device identity. Restart the login.",
    });
  });
});
