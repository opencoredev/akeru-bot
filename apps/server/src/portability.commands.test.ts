import { BotId } from "@akeru/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";
import { decideCommandSequence } from "./orchestration/decider.ts";
import {
  commandsForPortabilityImport,
  createPortabilityArchive,
  summarizePortabilityApply,
} from "./portability.ts";

import {
  makeSnapshot,
  makeSettings,
  NOW,
  URL_MCP_ID,
  AVAILABLE_PROVIDER_IDS,
  STDIO_MCP_ID,
  makePreflightSnapshot,
  BOT_ID,
  LATER,
  GROUP_ID,
} from "./portabilityTestSupport.ts";

describe("portability import", () => {
  it("plans valid orchestration commands and keeps every restored MCP server disabled", () => {
    const source = makeSnapshot();
    const archive = createPortabilityArchive(source, makeSettings(), NOW);

    const target = makeSnapshot({
      bots: [],
      groups: [],
      mcpServers: [
        {
          id: URL_MCP_ID,
          name: "Old search",
          transport: "url" as const,
          url: "https://example.com/mcp",
          enabled: true,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      threads: [],
    });

    const first = commandsForPortabilityImport(
      archive,
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    );

    const second = commandsForPortabilityImport(
      archive,
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    );

    expect(first.commands.map((command) => command.type)).toEqual(
      expect.arrayContaining([
        "mcp-server.update",
        "mcp-server.disable",
        "mcp-server.create",
        "bot.create",
        "group.create",
        "thread.create",
        "thread.history.restore",
      ]),
    );
    expect(first.commands).toContainEqual(
      expect.objectContaining({
        type: "mcp-server.create",
        mcpServerId: STDIO_MCP_ID,
        enabled: false,
      }),
    );
    expect(first.commands).toContainEqual(
      expect.objectContaining({ type: "mcp-server.disable", mcpServerId: URL_MCP_ID }),
    );
    expect(first.commands).not.toContainEqual(
      expect.objectContaining({ type: "mcp-server.disable", mcpServerId: STDIO_MCP_ID }),
    );
    expect(
      first.commands.findIndex(
        (command) => command.type === "mcp-server.disable" && command.mcpServerId === URL_MCP_ID,
      ),
    ).toBeLessThan(
      first.commands.findIndex(
        (command) => command.type === "mcp-server.update" && command.mcpServerId === URL_MCP_ID,
      ),
    );
    expect(first.commands).not.toContainEqual(expect.objectContaining({ type: "bot.restore" }));
    expect(first.commands.map((command) => command.commandId)).not.toEqual(
      second.commands.map((command) => command.commandId),
    );
    expect(first.applied).toBeGreaterThan(0);
  });

  it("exports MCP guidance and restores it after the server", () => {
    const base = makeSnapshot();

    const source = makeSnapshot({
      mcpServers: (base.mcpServers ?? []).map((server) =>
        server.id === URL_MCP_ID ? { ...server, instructions: "Use for web search." } : server,
      ),
    });

    const archive = createPortabilityArchive(source, makeSettings(), NOW);
    expect(
      archive.records.find((record) => record.type === "mcp-server" && record.id === URL_MCP_ID)
        ?.data,
    ).toMatchObject({ instructions: "Use for web search." });

    const target = makeSnapshot({ bots: [], groups: [], mcpServers: [], threads: [] });

    const { commands } = commandsForPortabilityImport(
      archive,
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    );

    const createIndex = commands.findIndex(
      (command) => command.type === "mcp-server.create" && command.mcpServerId === URL_MCP_ID,
    );

    const instructionsIndex = commands.findIndex(
      (command) =>
        command.type === "mcp-server.instructions.set" &&
        command.mcpServerId === URL_MCP_ID &&
        command.instructions === "Use for web search.",
    );

    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(instructionsIndex).toBeGreaterThan(createIndex);
    expect(
      commands.some(
        (command) =>
          command.type === "mcp-server.instructions.set" && command.mcpServerId === STDIO_MCP_ID,
      ),
    ).toBe(false);
  });

  effectIt.effect("preflights the complete restore plan through the decider", () => {
    const source = makePreflightSnapshot();
    const target = makeSnapshot({ bots: [], groups: [], mcpServers: [], threads: [] });

    const commands = commandsForPortabilityImport(
      createPortabilityArchive(source, makeSettings(), NOW),
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    ).commands;

    const historyCommand = commands.find((command) => command.type === "thread.history.restore");

    return decideCommandSequence({ commands, readModel: target }).pipe(
      Effect.tap((events) =>
        Effect.sync(() => {
          expect(events.length).toBeGreaterThan(0);
          expect(events.map((event) => event.type)).toEqual(
            expect.arrayContaining([
              "thread.message-sent",
              "thread.proposed-plan-upserted",
              "thread.activity-appended",
              "thread.snoozed",
              "thread.pinned",
            ]),
          );
          expect(
            events.find((event) => event.type === "thread.activity-appended")?.payload,
          ).toEqual(
            expect.objectContaining({
              activity: expect.objectContaining({ kind: "approval.history" }),
            }),
          );
          expect(
            events
              .filter((event) => event.commandId === historyCommand?.commandId)
              .every((event) => event.metadata.importedHistory === true),
          ).toBe(true);
        }),
      ),
      Effect.provide(NodeServices.layer),
    );
  });

  it("sets a replacement boss before changing the remaining membership", () => {
    const secondBotId = BotId.make("bot-second");

    const source = makeSnapshot({
      bots: [
        makeSnapshot().bots[0]!,
        {
          ...makeSnapshot().bots[0]!,
          id: secondBotId,
          name: "Second",
          avatar: { kind: "dither", seed: secondBotId },
        },
      ],
      groups: [
        {
          ...makeSnapshot().groups[0]!,
          bossBotId: secondBotId,
          members: [
            { kind: "bot", botId: secondBotId, role: "boss" },
            { kind: "bot", botId: BOT_ID, role: "specialist" },
          ],
        },
      ],
    });

    const target = makeSnapshot({
      bots: source.bots,
      groups: makeSnapshot().groups,
    });

    const commands = commandsForPortabilityImport(
      createPortabilityArchive(source, makeSettings(), NOW),
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    ).commands;

    const bossIndex = commands.findIndex((command) => command.type === "group.boss.set");
    const memberIndex = commands.findIndex((command) => command.type.startsWith("group.member."));

    expect(bossIndex).toBeGreaterThanOrEqual(0);
    expect(memberIndex === -1 || bossIndex < memberIndex).toBe(true);
  });

  it("temporarily restores an archived bot before restoring its thread", () => {
    const archivedBot = {
      ...makeSnapshot().bots[0]!,
      groupId: null,
      archivedAt: NOW,
    };

    const source = makeSnapshot({ bots: [archivedBot], groups: [] });
    const target = makeSnapshot({ bots: [archivedBot], groups: [], threads: [] });

    const commands = commandsForPortabilityImport(
      createPortabilityArchive(source, makeSettings(), NOW),
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    ).commands;

    const restoreIndex = commands.findIndex((command) => command.type === "bot.restore");
    const threadIndex = commands.findIndex((command) => command.type === "thread.create");
    const archiveIndex = commands.findIndex((command) => command.type === "bot.archive");

    expect(restoreIndex).toBeGreaterThanOrEqual(0);
    expect(threadIndex).toBeGreaterThan(restoreIndex);
    expect(archiveIndex).toBeGreaterThan(threadIndex);
  });

  it("restores conversation history and lifecycle without starting a provider turn", () => {
    const archivedThread = { ...makeSnapshot().threads[0]!, archivedAt: NOW, pinnedAt: NOW };
    const source = makeSnapshot({ threads: [archivedThread] });

    const target = makeSnapshot({
      threads: [
        { ...archivedThread, pinnedAt: null, messages: [], proposedPlans: [], activities: [] },
      ],
    });

    const commands = commandsForPortabilityImport(
      createPortabilityArchive(source, makeSettings(), NOW),
      target,
      makeSettings(),
      AVAILABLE_PROVIDER_IDS,
    ).commands;

    const restore = commands.find((command) => command.type === "thread.history.restore");

    expect(restore).toMatchObject({
      type: "thread.history.restore",
      archivedAt: NOW,
      pinnedAt: NOW,
      snoozedUntil: LATER,
    });
    expect(restore?.messages).toHaveLength(2);
    expect(restore?.proposedPlans).toHaveLength(1);
    expect(restore?.activities).toEqual([
      expect.objectContaining({ kind: "approval.history", payload: expect.any(Object) }),
    ]);
    expect(commands).not.toContainEqual(expect.objectContaining({ type: "thread.turn.start" }));
  });

  it("reports failed and partly applied records separately", () => {
    const botItem = { recordType: "bot" as const, id: BOT_ID, title: "Akeru" };
    const groupItem = { recordType: "group" as const, id: GROUP_ID, title: "Builders" };

    expect(
      summarizePortabilityApply(
        [
          { item: botItem, succeeded: true },
          { item: botItem, succeeded: false, message: "Archive step failed." },
          { item: groupItem, succeeded: false, message: "Group restore failed." },
        ],
        2,
      ),
    ).toEqual({
      applied: 0,
      skipped: 2,
      failed: 1,
      partial: 1,
      failures: [
        { ...botItem, partial: true, message: "Archive step failed." },
        { ...groupItem, partial: false, message: "Group restore failed." },
      ],
    });
  });
});
