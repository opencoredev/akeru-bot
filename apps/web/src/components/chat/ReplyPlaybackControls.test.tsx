import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { createReplyPlaybackController } from "@t3tools/client-runtime/reply-playback";
import { ReplyPlaybackControls } from "./ReplyPlaybackControls";

const identity = {
  environmentId: "environment",
  threadId: "thread",
  messageId: "message",
  contentVersion: "version",
  voice: "voice",
  provider: "provider",
};
const request = { identity, text: "Stored text", automatic: false };
function setup() {
  const controller = createReplyPlaybackController(async () => ({
    play: async () => {},
    pause: () => {},
    dispose: () => {},
  }));
  controller.setContext({ ...identity, connected: true, mediaBlocked: false });
  const render = () =>
    renderToStaticMarkup(<ReplyPlaybackControls controller={controller} request={request} />);
  return { controller, render };
}

describe("reply playback controls", () => {
  it("labels read, pause, resume and stop actions accessibly", async () => {
    const { controller, render } = setup();
    expect(render()).toContain('aria-label="Read aloud"');
    await controller.start(request);
    expect(render()).toContain('aria-label="Pause readout"');
    expect(render()).toContain('aria-label="Stop readout"');
    controller.pause();
    expect(render()).toContain('aria-label="Resume readout"');
    controller.stop();
    expect(render()).not.toContain('aria-label="Stop readout"');
  });
  it("does not show another reply's playback state", async () => {
    const { controller, render } = setup();
    await controller.start({ ...request, identity: { ...identity, messageId: "other" } });
    expect(render()).toContain('aria-label="Read aloud"');
    expect(render()).not.toContain('aria-label="Pause readout"');
  });
  it("discloses unavailable synthesis and skipped content", () => {
    const { controller } = setup();
    const markup = renderToStaticMarkup(
      <ReplyPlaybackControls
        controller={controller}
        request={request}
        unavailableReason="Choose a speech provider in voice settings."
        disclosure="Code blocks and images are skipped."
      />,
    );
    expect(markup).toContain("disabled");
    expect(markup).toContain("Choose a speech provider in voice settings.");
    expect(markup).toContain("Code blocks and images are skipped.");
  });
});
