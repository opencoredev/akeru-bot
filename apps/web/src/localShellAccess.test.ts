import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isLocalShellTarget } from "./localShellAccess";

const environmentId = EnvironmentId.make("environment-1");

const primaryTarget = (httpBaseUrl: string) =>
  new PrimaryConnectionTarget({
    environmentId,
    label: "sol",
    httpBaseUrl,
    wsBaseUrl: httpBaseUrl.replace("http", "ws"),
  });

describe("isLocalShellTarget", () => {
  it("treats a loopback primary target as local", () => {
    expect(
      isLocalShellTarget({
        target: primaryTarget("http://127.0.0.1:8000"),
        isDesktopRenderer: false,
      }),
    ).toBe(true);
  });

  it("treats a primary target reached over the network as remote", () => {
    expect(
      isLocalShellTarget({
        target: primaryTarget("https://sol.tail1234.ts.net"),
        isDesktopRenderer: false,
      }),
    ).toBe(false);
  });

  it("treats the desktop app's own primary as local even on a NAT URL", () => {
    expect(
      isLocalShellTarget({
        target: primaryTarget("http://172.29.112.1:14369"),
        isDesktopRenderer: true,
      }),
    ).toBe(true);
  });

  it("treats desktop-local secondary backends as local", () => {
    expect(
      isLocalShellTarget({
        target: new BearerConnectionTarget({
          environmentId,
          label: "WSL (Ubuntu)",
          connectionId: "local:wsl-1",
        }),
        isDesktopRenderer: false,
      }),
    ).toBe(true);
  });

  it("falls back to local when the environment has no catalog entry", () => {
    expect(isLocalShellTarget({ target: null, isDesktopRenderer: false })).toBe(true);
  });
});
