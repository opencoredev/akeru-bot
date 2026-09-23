// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { BotId } from "@t3tools/contracts";
import { BotInboxService } from "./service.ts";
import { recordBrowserFailure, resolveBrowserFailure } from "./browserIncidents.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});

describe("browser inbox producer", () => {
  it("opens once, resolves on attach, and reopens with an incremented occurrence", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-browser-inbox-"));
    directories.push(directory);
    const service = new BotInboxService(NodePath.join(directory, "inbox.json"));
    const input = {
      botId: BotId.make("bot-one"),
      botName: "Akeru",
      taskOrRoutine: "Research task",
      detail: "The managed browser endpoint refused the MCP session.",
    };

    recordBrowserFailure(service, input);
    recordBrowserFailure(service, input);
    expect(service.list()).toHaveLength(1);
    expect(service.list()[0]?.occurrenceCount).toBe(1);
    resolveBrowserFailure(service, input.botId);
    recordBrowserFailure(service, { ...input, detail: "The browser process exited." });

    const open = service.list().find((item) => item.status === "open");
    expect(open).toMatchObject({ status: "open", occurrenceCount: 2 });
    expect(
      new BotInboxService(NodePath.join(directory, "inbox.json"))
        .list()
        .some((item) => item.status === "open"),
    ).toBe(true);
  });
});
