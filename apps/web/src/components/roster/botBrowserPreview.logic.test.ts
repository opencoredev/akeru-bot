import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  botBrowserPreviewRuntimeTabId,
  hasBotBrowserPage,
  resolveBotBrowserPreviewStatus,
} from "./botBrowserPreview.logic";

const base = {
  supported: true,
  hasThread: true,
  hasSession: true,
  hasWebContents: true,
  loading: false,
  failed: false,
};

describe("bot browser preview", () => {
  it("shows honest unsupported, waiting, loading, ready, and failure states", () => {
    expect(resolveBotBrowserPreviewStatus({ ...base, supported: false })).toBe("unsupported");
    expect(resolveBotBrowserPreviewStatus({ ...base, hasSession: false })).toBe("waiting");
    expect(resolveBotBrowserPreviewStatus({ ...base, hasWebContents: false })).toBe("loading");
    expect(resolveBotBrowserPreviewStatus({ ...base, loading: true })).toBe("loading");
    expect(resolveBotBrowserPreviewStatus(base)).toBe("ready");
    expect(resolveBotBrowserPreviewStatus({ ...base, failed: true })).toBe("failed");
  });

  it("waits rather than connecting when the bot has never run", () => {
    // A bot with no thread has nothing to connect to, so claiming a connection
    // is in progress left the card saying "Connecting" forever.
    expect(resolveBotBrowserPreviewStatus({ ...base, hasThread: false, hasSession: false })).toBe(
      "waiting",
    );
    expect(resolveBotBrowserPreviewStatus({ ...base, hasThread: false })).toBe("waiting");
  });

  it("keeps unsupported ahead of every other state", () => {
    expect(
      resolveBotBrowserPreviewStatus({
        ...base,
        supported: false,
        hasThread: false,
        hasSession: false,
        failed: true,
        loading: true,
      }),
    ).toBe("unsupported");
  });

  it("reports failure ahead of a stale loading flag", () => {
    expect(resolveBotBrowserPreviewStatus({ ...base, failed: true, loading: true })).toBe("failed");
    expect(resolveBotBrowserPreviewStatus({ ...base, failed: true, hasWebContents: false })).toBe(
      "failed",
    );
  });

  it("hides the inline preview until the bot has a page", () => {
    expect(hasBotBrowserPage("unsupported")).toBe(false);
    expect(hasBotBrowserPage("waiting")).toBe(false);
    expect(hasBotBrowserPage("loading")).toBe(true);
    expect(hasBotBrowserPage("ready")).toBe(true);
    expect(hasBotBrowserPage("failed")).toBe(true);
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
