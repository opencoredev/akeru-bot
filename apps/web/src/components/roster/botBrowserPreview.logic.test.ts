import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  botBrowserPreviewRuntimeTabId,
  resolveBotBrowserPreviewStatus,
} from "./botBrowserPreview.logic";

describe("bot browser preview", () => {
  it("shows honest unsupported, waiting, loading, ready, and failure states", () => {
    const base = {
      supported: true,
      hasThread: true,
      hasSession: true,
      hasWebContents: true,
      loading: false,
      failed: false,
    };

    expect(resolveBotBrowserPreviewStatus({ ...base, supported: false })).toBe("unsupported");
    expect(resolveBotBrowserPreviewStatus({ ...base, hasThread: false })).toBe("connecting");
    expect(resolveBotBrowserPreviewStatus({ ...base, hasSession: false })).toBe("waiting");
    expect(resolveBotBrowserPreviewStatus({ ...base, hasWebContents: false })).toBe("loading");
    expect(resolveBotBrowserPreviewStatus({ ...base, loading: true })).toBe("loading");
    expect(resolveBotBrowserPreviewStatus(base)).toBe("ready");
    expect(resolveBotBrowserPreviewStatus({ ...base, failed: true })).toBe("failed");
  });

  it("uses the environment and thread in each browser surface id", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const first = botBrowserPreviewRuntimeTabId(
      { environmentId, threadId: ThreadId.make("thread-1") },
      "epoch-1",
      "tab-1",
    );
    const second = botBrowserPreviewRuntimeTabId(
      { environmentId, threadId: ThreadId.make("thread-2") },
      "epoch-1",
      "tab-1",
    );

    expect(first).not.toBe(second);
  });
});
