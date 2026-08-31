// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { BotId } from "@t3tools/contracts";

import { BotInboxService } from "./service.ts";
import { recordUserActionIncident, userActionIncidentKey } from "./userActionIncidents.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

function makeService() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-user-action-inbox-"));
  directories.push(directory);
  const filePath = NodePath.join(directory, "bot-inbox.json");
  return { filePath, service: new BotInboxService(filePath) };
}

const input = {
  botId: BotId.make("bot-akeru"),
  botName: "Akeru",
  toolId: "request_box_help",
  summary: "Sign in to the bank site.",
  nextAction: "Open the bot workspace and complete the requested step.",
  target: "login",
};

describe("user-action inbox incidents", () => {
  it("records request_box_help on the existing inbox", () => {
    const { service } = makeService();
    const item = recordUserActionIncident(service, input);

    expect(item.incidentKey).toBe(
      userActionIncidentKey({ botId: input.botId, toolId: input.toolId, target: input.target }),
    );
    expect(item.kind).toBe("approval-request");
    expect(item.lastFailure).toBe(input.summary);
    expect(service.list().filter((candidate) => candidate.status === "open")).toEqual([item]);
  });

  it("deduplicates the same help request and keeps a later occurrence", () => {
    const { service } = makeService();
    const first = recordUserActionIncident(service, input);
    const second = recordUserActionIncident(service, {
      ...input,
      summary: "The login form is asking for a one-time code.",
    });

    expect(second.id).toBe(first.id);
    expect(second.occurrenceCount).toBe(2);
    expect(second.lastFailure).toBe("The login form is asking for a one-time code.");
    expect(service.list().filter((candidate) => candidate.status === "open")).toHaveLength(1);
  });

  it("opens a new incident for a different target", () => {
    const { service } = makeService();
    recordUserActionIncident(service, input);
    recordUserActionIncident(service, { ...input, target: "captcha" });

    expect(
      service
        .list()
        .filter((item) => item.status === "open")
        .map((item) => item.incidentKey)
        .sort(),
    ).toEqual([
      "user-action:bot-akeru:request_box_help:captcha",
      "user-action:bot-akeru:request_box_help:login",
    ]);
  });

  it("deduplicates after restart", () => {
    const { filePath, service } = makeService();
    const first = recordUserActionIncident(service, input);
    const restarted = new BotInboxService(filePath);
    const repeated = recordUserActionIncident(restarted, input);

    expect(repeated.id).toBe(first.id);
    expect(repeated.occurrenceCount).toBe(2);
    expect(new BotInboxService(filePath).list()).toEqual([repeated]);
  });
});
