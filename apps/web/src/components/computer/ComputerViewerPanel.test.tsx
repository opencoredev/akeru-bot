import {
  deriveComputerViewer,
  type ComputerCapabilityExplanation,
} from "@t3tools/client-runtime/state/computer-viewer";
import {
  createComputerViewerController,
  type ComputerViewerController,
  type ComputerViewerPort,
} from "@t3tools/client-runtime/state/computer-viewer-controller";
import { ThreadId, type ComputerFrame, type ComputerState } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ComputerViewerPanel, computerViewerKeyAction } from "./ComputerViewerPanel";

const threadId = ThreadId.make("thread-computer");
const frame: ComputerFrame = { mimeType: "image/png", data: "AAAA", width: 1280, height: 800 };

function serverState(overrides: Partial<ComputerState> = {}): ComputerState {
  return {
    threadId,
    status: "ready",
    capability: "desktop",
    controlAvailable: true,
    reason: null,
    workspaceId: "workspace-1",
    ...overrides,
  };
}

function fakePort(overrides: Partial<ComputerViewerPort> = {}): ComputerViewerPort {
  return {
    getState: vi.fn(async () => ({ ok: true as const, value: serverState() })),
    open: vi.fn(async () => ({ ok: true as const, value: serverState() })),
    acquire: vi.fn(async () => ({
      ok: true as const,
      value: { sessionId: "lease-1", expiresAt: 60_000, state: serverState({ status: "human" }) },
    })),
    input: vi.fn(async () => ({ ok: true as const, value: undefined })),
    release: vi.fn(async () => ({ ok: true as const, value: serverState() })),
    close: vi.fn(async () => ({ ok: true as const, value: serverState() })),
    stop: vi.fn(async () => ({ ok: true as const, value: serverState({ status: "stopped" }) })),
    ...overrides,
  };
}

function render(
  controller: ComputerViewerController,
  capability: ComputerCapabilityExplanation = "available",
) {
  const state = controller.getState();
  return renderToStaticMarkup(
    <ComputerViewerPanel
      botName="Akeru"
      view={deriveComputerViewer(state)}
      frame={state.frame}
      notice={state.notice}
      capability={capability}
      onTakeControl={() => {}}
      onReturnControl={() => {}}
      onStop={() => {}}
      onResume={() => {}}
      onInput={() => {}}
    />,
  );
}

function actions(html: string): string[] {
  return [...html.matchAll(/data-computer-action="([a-z]+)"/g)].map((match) => match[1]!);
}

function owners(html: string): string[] {
  return [...html.matchAll(/data-computer-owner="([a-z-]+)"/g)].map((match) => match[1]!);
}

async function shownController(port = fakePort()) {
  const controller = createComputerViewerController({ port });
  await controller.show();
  controller.receive({ _tag: "frame", frame });
  return controller;
}

describe("ComputerViewerPanel", () => {
  it("uses local clipboard text for paste shortcuts", () => {
    const key = { key: "v", altKey: false, shiftKey: false };
    expect(computerViewerKeyAction({ ...key, ctrlKey: true, metaKey: false })).toBeNull();
    expect(computerViewerKeyAction({ ...key, ctrlKey: false, metaKey: true })).toBeNull();
    expect(
      computerViewerKeyAction({ ...key, key: "c", ctrlKey: true, metaKey: false }),
    ).toMatchObject({ _tag: "key" });
  });

  it("offers take control and stop while the bot drives", async () => {
    const html = render(await shownController());
    expect(owners(html)).toEqual(["bot"]);
    expect(html).toContain("Akeru is in control");
    expect(actions(html)).toEqual(["take", "stop"]);
    expect(html).toContain('role="application"');
    expect(html).toContain('tabindex="-1"');
  });

  it("takes control, then returns it to the bot", async () => {
    const port = fakePort();
    const controller = await shownController(port);
    await controller.takeControl();
    let html = render(controller);
    expect(owners(html)).toEqual(["you"]);
    expect(actions(html)).toEqual(["return", "stop"]);
    expect(html).toContain("Return to Akeru");
    expect(html).toContain('tabindex="0"');

    await controller.returnControl();
    expect(port.release).toHaveBeenCalledWith("lease-1");
    html = render(controller);
    expect(owners(html)).toEqual(["bot"]);
    expect(actions(html)).toEqual(["take", "stop"]);
  });

  it("stops the computer and offers resume", async () => {
    const port = fakePort();
    const controller = await shownController(port);
    await controller.takeControl();
    await controller.stop();
    const html = render(controller);
    expect(port.stop).toHaveBeenCalledTimes(1);
    expect(owners(html)).toEqual(["nobody"]);
    expect(actions(html)).toEqual(["resume"]);
    expect(html).toContain('data-computer-phase="stopped"');
    expect(html).not.toContain('role="application"');

    await controller.resume();
    expect(actions(render(controller))).toEqual(["take", "stop"]);
  });

  it("drops a stale lease and says why", async () => {
    const controller = await shownController();
    await controller.takeControl();
    controller.dispatch({ type: "tick", now: 60_000 });
    const html = render(controller);
    expect(owners(html)).toEqual(["nobody"]);
    expect(html).toContain('data-computer-notice="expired"');
    expect(html).toContain("Your minute of control ran out");
    expect(actions(html)).toEqual(["resume"]);
  });

  it("shows another client's control without offering to take it", async () => {
    const controller = await shownController();
    controller.receive({ _tag: "state", state: serverState({ status: "human" }) });
    const html = render(controller);
    expect(owners(html)).toEqual(["someone-else"]);
    expect(html).toMatch(
      /data-computer-action="take"[^>]*disabled|disabled[^>]*data-computer-action="take"/,
    );
  });

  it("reports losing a race to take control", async () => {
    const controller = await shownController(
      fakePort({ acquire: vi.fn(async () => ({ ok: false as const, code: "busy" as const })) }),
    );
    await controller.takeControl();
    const html = render(controller);
    expect(html).toContain('data-computer-notice="busy"');
    expect(owners(html)).not.toContain("you");
  });

  it("explains an unsupported computer instead of showing controls", async () => {
    const controller = createComputerViewerController({
      port: fakePort({
        getState: vi.fn(async () => ({
          ok: true as const,
          value: serverState({ status: "unavailable", capability: "none" }),
        })),
      }),
    });
    await controller.show();
    const html = render(controller, "provider");
    expect(actions(html)).toEqual([]);
    expect(html).toContain("Computer control needs a Codex or Kimi For Coding engine");
  });
});
