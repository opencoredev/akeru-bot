import { describe, expect, it } from "vite-plus/test";
import * as EffectAcpErrors from "effect-acp/errors";
import { ProviderDriverKind, ThreadId } from "@t3tools/contracts";

import { acpPermissionOutcome, mapAcpToAdapterError } from "./AcpAdapterSupport.ts";

describe("AcpAdapterSupport", () => {
  it("maps ACP approval decisions to permission outcomes", () => {
    expect(acpPermissionOutcome("accept")).toBe("allow-once");
    expect(acpPermissionOutcome("acceptForSession")).toBe("allow-always");
    expect(acpPermissionOutcome("decline")).toBe("reject-once");
  });

  it.each([
    new EffectAcpErrors.AcpRequestError({
      code: -32602,
      errorMessage: "Invalid params",
    }),
    new EffectAcpErrors.AcpTransportError({ cause: "connection closed" }),
    new EffectAcpErrors.AcpSpawnError({ command: "agent", cause: "not found" }),
    new EffectAcpErrors.AcpProtocolParseError({
      operation: "decode-wire-message",
      cause: "invalid JSON",
    }),
    new EffectAcpErrors.AcpInputStreamEndedError({}),
  ])("maps $_tag to a request error and preserves its cause", (cause) => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("cursor"),
      ThreadId.make("thread-1"),
      "session/prompt",
      cause,
    );

    expect(error).toMatchObject({
      _tag: "ProviderAdapterRequestError",
      provider: "cursor",
      method: "session/prompt",
      detail: cause.message,
    });
    expect(error.cause).toBe(cause);
    expect(error.message).toContain(cause.message);
  });

  it("maps an exited ACP process to a closed session instead of a request error", () => {
    const cause = new EffectAcpErrors.AcpProcessExitedError({ code: 1 });
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("cursor"),
      ThreadId.make("thread-1"),
      "session/prompt",
      cause,
    );

    expect(error).toMatchObject({
      _tag: "ProviderAdapterSessionClosedError",
      provider: "cursor",
      threadId: "thread-1",
    });
    expect(error.cause).toBe(cause);
  });
});
