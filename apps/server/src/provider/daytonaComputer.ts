import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import type { Sandbox } from "@daytona/sdk";
import { Schema } from "effect";
import { ComputerFrame, type ComputerAction, COMPUTER_FRAME_MAX_BYTES } from "@akeru/contracts";
import { MAX_SCREENSHOT_BYTES, redactComputerScreenshot } from "../mcp/PreviewSnapshotRedaction.ts";

const decodeFrame = Schema.decodeUnknownSync(ComputerFrame);

/** Native desktop only; credentials and screenshots never leave the server except via computer events. */
export class DaytonaComputer {
  private readonly sandbox: Sandbox;
  constructor(sandbox: Sandbox) {
    this.sandbox = sandbox;
  }

  async open() {
    await this.sandbox.computerUse.start();
  }

  async input(action: ComputerAction) {
    const computer = this.sandbox.computerUse;

    await Match.value(action).pipe(
      Match.tags({
        click: (action) => computer.mouse.click(action.x, action.y, action.button),
        move: (action) => computer.mouse.move(action.x, action.y),
        key: (action) => computer.keyboard.hotkey(action.key),
        type: (action) => computer.keyboard.type(action.text),
        scroll: async (action) => {
          const position = await computer.mouse.getPosition();
          await computer.mouse.scroll(
            position.x ?? 0,
            position.y ?? 0,
            action.direction,
            action.amount,
          );
        },
      }),
      Match.exhaustive,
    );
  }

  async capture(): Promise<ComputerFrame> {
    const screenshot = await this.sandbox.computerUse.screenshot.takeCompressed({
      format: "png",
      scale: 1,
    });

    const display = await this.sandbox.computerUse.display.getInfo();
    const encoded = screenshot.screenshot;

    if (!Predicate.isString(encoded) || encoded.length > Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4) {
      throw new Error("Computer screenshot is too large.");
    }

    const raw = Buffer.from(encoded, "base64");

    if (raw.byteLength > MAX_SCREENSHOT_BYTES) {
      throw new Error("Computer screenshot exceeds the transport budget.");
    }

    const redacted = redactComputerScreenshot({ mediaType: "image/png", data: raw });

    if (redacted.data.byteLength > Math.min(MAX_SCREENSHOT_BYTES, COMPUTER_FRAME_MAX_BYTES)) {
      throw new Error("Redacted computer screenshot exceeds the transport budget.");
    }

    const bytes = Buffer.from(redacted.data);

    if (
      bytes.readUInt32BE(16) !== display.displays?.[0]?.width ||
      bytes.readUInt32BE(20) !== display.displays?.[0]?.height
    ) {
      throw new Error("Computer screenshot dimensions do not match the display.");
    }

    const data = bytes.toString("base64");

    return decodeFrame({
      mimeType: "image/png",
      data,
      width: display.displays?.[0]?.width,
      height: display.displays?.[0]?.height,
    });
  }
}
