import { describe, expect, it } from "vite-plus/test";

import { withoutErrorStack } from "./errorText.ts";

const STACK = [
  "ProviderValidationError: Provider validation failed in AgentController.inspectEngine: Provider instance 'codex' is disabled in Akeru Bot settings.",
  "    at disabledProviderError (file:///home/leo/akeru/apps/server/src/provider/Layers/AgentController.ts:584:10)",
  "    at AgentController.inspectEngine (definition) (file:///home/leo/akeru/apps/server/src/provider/Layers/AgentController.ts:2497:73)",
  "    at ensureSessionForThread (file:///home/leo/akeru/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:1282:28)",
].join("\n");

describe("withoutErrorStack", () => {
  it("keeps the first line of a stored stack without its class name", () => {
    expect(withoutErrorStack(STACK)).toBe(
      "Provider validation failed in AgentController.inspectEngine: Provider instance 'codex' is disabled in Akeru Bot settings.",
    );
  });

  it("cuts a stack that was collapsed onto one line", () => {
    expect(withoutErrorStack(STACK.replace(/\n\s+/g, " "))).toBe(
      "Provider validation failed in AgentController.inspectEngine: Provider instance 'codex' is disabled in Akeru Bot settings.",
    );
    expect(withoutErrorStack("Boom at file:///srv/app.js:1:2")).toBe("Boom");
    expect(withoutErrorStack("Error: Boom\n    at run (node:internal/x:1:2)")).toBe("Boom");
    expect(withoutErrorStack("Boom at new Worker (node:internal/worker:1:2)")).toBe("Boom");
  });

  it("removes bare path frames", () => {
    expect(withoutErrorStack("Error: Boom\n    at /srv/app.js:12:3")).toBe("Boom");
    expect(withoutErrorStack("Error: Boom\n    at C:\\srv\\app.js:12:3")).toBe("Boom");
    expect(withoutErrorStack("Error: Boom\n    at async /srv/app.js:12:3")).toBe("Boom");
    expect(withoutErrorStack("Boom at /srv/app.js:12:3")).toBe("Boom");
    expect(withoutErrorStack("Failed at /srv/app.js:12:3 because permission was denied")).toBe(
      "Failed at /srv/app.js:12:3 because permission was denied",
    );
    expect(
      withoutErrorStack("Error: Bad input\n- Missing key\n    at /srv/app.js:1:2\nMore detail"),
    ).toBe("Bad input\n- Missing key\nMore detail");
  });

  it("keeps the details of a multi-line message", () => {
    const message = "Validation failed:\n- Missing API key\n- Choose a configured model";
    expect(withoutErrorStack(message)).toBe(message);
    expect(
      withoutErrorStack(
        `Error: ${message}\n    at validate (/srv/app/validate.js:12:3)\n    at async Promise.all (index 0)`,
      ),
    ).toBe(message);
  });

  it("removes stack frames between message lines", () => {
    expect(
      withoutErrorStack(
        [
          "Error: Request failed",
          "    at send (file:///srv/app.js:1:2)",
          "    at <anonymous>",
          "Caused by: connection refused",
          "    at connect (node:net:3:4)",
        ].join("\n"),
      ),
    ).toBe("Request failed\nCaused by: connection refused");
  });

  it("leaves readable messages alone", () => {
    for (const message of [
      "Ren could not start: Provider instance 'codex' is disabled in Akeru Bot settings.",
      "Could not look at the file.",
      "The server restarted before this work finished.",
      "See https://example.com at noon.",
      "Try again at 10:30:00.",
    ]) {
      expect(withoutErrorStack(message)).toBe(message);
    }
    expect(withoutErrorStack("")).toBe("");
  });
});
