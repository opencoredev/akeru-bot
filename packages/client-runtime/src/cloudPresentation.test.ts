import { CloudEnvironmentId } from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";

import { cloudSummaryLabel, cloudViewModel } from "./cloudPresentation.ts";

describe("cloudViewModel", () => {
  it("maps every link state to a view", () => {
    expect(cloudViewModel(null)).toEqual({ kind: "loading" });
    expect(cloudViewModel({ status: "unlinked" })).toEqual({ kind: "unlinked" });
    expect(cloudViewModel({ status: "revoked" })).toEqual({ kind: "revoked" });
    expect(
      cloudViewModel({
        status: "linking",
        userCode: "ABCD-1234",
        verificationUrl: "https://cloud.test/link",
        expiresAt: "2026-09-29T00:10:00.000Z",
      }),
    ).toMatchObject({ kind: "linking", userCode: "ABCD-1234" });
  });

  it("labels the linked connection state", () => {
    const view = cloudViewModel({
      status: "linked",
      account: { email: "ada@example.com" },
      environmentId: CloudEnvironmentId.make("env_1"),
      connection: "offline",
    });

    expect(view).toEqual({
      kind: "linked",
      email: "ada@example.com",
      connectionLabel: "Offline",
      connectionTone: "offline",
    });
    expect(cloudSummaryLabel(view)).toBe("Offline");
  });
});
