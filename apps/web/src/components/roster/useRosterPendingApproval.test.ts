import { ApprovalRequestId, type ScopedThreadRef } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { rosterApprovalResponseKey } from "./useRosterPendingApproval";

describe("roster approval response state", () => {
  it("is scoped by environment, thread, and request", () => {
    const thread = {
      environmentId: "local",
      threadId: "thread-a",
    } as ScopedThreadRef;
    const requestId = ApprovalRequestId.make("request-a");
    const key = rosterApprovalResponseKey(thread, requestId);

    expect(
      rosterApprovalResponseKey({ ...thread, threadId: "thread-b" } as ScopedThreadRef, requestId),
    ).not.toBe(key);
    expect(
      rosterApprovalResponseKey(
        { ...thread, environmentId: "remote" } as ScopedThreadRef,
        requestId,
      ),
    ).not.toBe(key);
    expect(rosterApprovalResponseKey(thread, ApprovalRequestId.make("request-b"))).not.toBe(key);
  });
});
