import { describe, expect, it } from "vite-plus/test";

import {
  AgentControllerRuntimeError,
  ProviderAdapterRequestError,
  ProviderValidationError,
  readableErrorDetail,
} from "./Errors.ts";

describe("readableErrorDetail", () => {
  it("keeps only the issue of a validation error", () => {
    expect(
      readableErrorDetail(
        new ProviderValidationError({
          operation: "AgentController.inspectEngine",
          issue: "Provider instance 'codex' is disabled in Akeru Bot settings.",
        }),
      ),
    ).toBe("Provider instance 'codex' is disabled in Akeru Bot settings.");
  });

  it("keeps only the detail of request and controller errors", () => {
    expect(
      readableErrorDetail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "turn/start",
          detail: "Rate limited.",
        }),
      ),
    ).toBe("Rate limited.");
    expect(
      readableErrorDetail(
        new AgentControllerRuntimeError({ operation: "sendTurn", detail: "Session closed." }),
      ),
    ).toBe("Session closed.");
  });

  it("drops stack frames from other errors", () => {
    expect(
      readableErrorDetail(
        "Error: boom\n    at run (file:///srv/app/server.ts:1:1)\n    at main (file:///srv/app/main.ts:2:2)",
      ),
    ).toBe("Error: boom");
    expect(readableErrorDetail(new Error("Plain failure."))).toBe("Plain failure.");
    expect(readableErrorDetail(undefined)).toBe("Something went wrong.");
  });
});
