import { renderToStaticMarkup } from "react-dom/server";
import { presentThreadError } from "@t3tools/client-runtime/errors";
import { describe, expect, it } from "vite-plus/test";

import {
  dismissThreadErrorBannerForSession,
  getThreadErrorBannerKey,
  isThreadErrorBannerDismissedForSession,
  shouldShowThreadErrorBanner,
  ThreadErrorBanner,
  threadErrorFeedbackDraft,
} from "./ThreadErrorBanner";

describe("ThreadErrorBanner", () => {
  it("stays hidden after its current error is dismissed", () => {
    const bannerKey = getThreadErrorBannerKey("env:thread-a", "Aborted");
    dismissThreadErrorBannerForSession(bannerKey);

    expect(
      shouldShowThreadErrorBanner(
        "env:thread-a",
        "Aborted",
        isThreadErrorBannerDismissedForSession(bannerKey),
      ),
    ).toBe(false);
  });

  it("reappears when a new error arrives on the same thread", () => {
    dismissThreadErrorBannerForSession(getThreadErrorBannerKey("env:thread-b", "Turn failed"));
    const newErrorKey = getThreadErrorBannerKey("env:thread-b", "Provider crashed");

    expect(isThreadErrorBannerDismissedForSession(newErrorKey)).toBe(false);
    expect(
      shouldShowThreadErrorBanner(
        "env:thread-b",
        "Provider crashed",
        isThreadErrorBannerDismissedForSession(newErrorKey),
      ),
    ).toBe(true);
  });

  it("scopes dismissals to the thread that dismissed them", () => {
    dismissThreadErrorBannerForSession(getThreadErrorBannerKey("env:thread-c", "Aborted"));
    const otherThreadKey = getThreadErrorBannerKey("env:other-thread", "Aborted");

    expect(isThreadErrorBannerDismissedForSession(otherThreadKey)).toBe(false);
    expect(
      shouldShowThreadErrorBanner(
        "env:other-thread",
        "Aborted",
        isThreadErrorBannerDismissedForSession(otherThreadKey),
      ),
    ).toBe(true);
  });

  it("keeps a dismissal across visiting threads with no error", () => {
    const bannerKey = getThreadErrorBannerKey("env:thread-d", "Aborted");
    dismissThreadErrorBannerForSession(bannerKey);

    expect(shouldShowThreadErrorBanner("env:thread-d", null, false)).toBe(false);
    expect(isThreadErrorBannerDismissedForSession(bannerKey)).toBe(true);
    expect(
      shouldShowThreadErrorBanner(
        "env:thread-d",
        "Aborted",
        isThreadErrorBannerDismissedForSession(bannerKey),
      ),
    ).toBe(false);
  });

  it("never shows a null error", () => {
    expect(shouldShowThreadErrorBanner("env:thread-e", null, false)).toBe(false);
  });
  it("shows a concise summary and keeps technical details collapsed", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner
        error={"The first error line\ncontinues on a second line"}
        threadKey="env:thread-summary"
        onDismiss={() => {}}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-label="Dismiss error"');
    expect(markup).toContain("The bot couldn’t finish that request");
    expect(markup).toContain("Technical details");
    expect(markup).not.toContain("continues on a second line");
  });

  it("offers a feedback draft without local paths or stack details", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner error="Provider crashed" threadKey="env:thread-feedback" />,
    );

    expect(markup).toContain("Send feedback");
    const draft = threadErrorFeedbackDraft(
      "Provider crashed on request req-123 at file:///home/leo/private.ts:1 with token: secret-value",
    );
    expect(draft).toContain("The bot couldn’t finish that request");
    expect(draft).toContain("req-123");
    expect(draft).not.toContain("/home/leo");
    expect(draft).not.toContain("secret-value");
  });

  it("does not ask for feedback about a rate limit or a dropped connection", () => {
    for (const error of ["429 Too Many Requests", "WebSocket disconnected"]) {
      const markup = renderToStaticMarkup(
        <ThreadErrorBanner error={error} threadKey={`env:thread-${error}`} />,
      );
      expect(markup).not.toContain("Send feedback");
    }
  });

  it("offers Resume for a recoverable failed request", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner
        error="Automatic recovery failed"
        threadKey="env:thread-resume"
        onResume={() => {}}
      />,
    );

    expect(markup).toContain(">Resume<");
  });

  it("turns a disabled provider exception into an actionable message", () => {
    const error =
      "ProviderValidationError: Provider validation failed in AgentController.inspectEngine: Provider instance 'codex' is disabled in Akeru Bot settings. at DisabledProviderError (file:///home/leo/app.ts:1:2)";

    expect(presentThreadError(error)).toEqual({
      title: "Codex is turned off",
      description: "Turn Codex on in Settings > Providers, then send your message again.",
      technicalDetails: "Provider instance “codex” is disabled.",
      action: "providers",
    });

    const markup = renderToStaticMarkup(
      <ThreadErrorBanner error={error} threadKey="env:thread-disabled-provider" />,
    );
    expect(markup).toContain("Codex is turned off");
    expect(markup).toContain('href="grokbot://app/v1/settings?id=providers"');
    expect(markup).not.toContain("Send feedback");
    expect(markup).not.toContain("AgentController.inspectEngine");
    expect(markup).not.toContain("/home/leo");
  });

  it("uses the server's failure category to name the provider and the fix", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner
        error="Claude authentication failed."
        threadKey="env:thread-expired"
        context={{ unavailability: "expired-login", providerName: "Claude" }}
      />,
    );

    expect(markup).toContain("Claude sign-in expired");
    expect(markup).toContain("Reconnect Claude in Settings &gt; Providers");
    expect(markup).toContain('href="grokbot://app/v1/settings?id=providers"');
    expect(markup).not.toContain("Send feedback");
  });
});
