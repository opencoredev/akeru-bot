import { PortabilityArchive, type PortabilityArchiveRecord } from "@akeru/contracts";
import * as Schema from "effect/Schema";

import { BUILTIN_MCP_PREFIX, ARCHIVE_RECORD_TYPES } from "./portabilityArchive.ts";
import { safeMcpCommand, safeMcpArgs, safeText } from "./portabilitySafety.ts";
import { canonicalJson, portabilityChecksum } from "./portabilityChecksums.ts";

export const decodeArchive = Schema.decodeUnknownSync(PortabilityArchive);

export function assertSafeImportedMcp(
  record: Extract<PortabilityArchiveRecord, { type: "mcp-server" }>,
) {
  if (
    record.data.catalogId !== undefined &&
    record.id !== `${BUILTIN_MCP_PREFIX}${record.data.catalogId}`
  ) {
    throw new Error(`MCP server '${record.id}' has an inconsistent catalog ID.`);
  }

  const config = record.data.configuration;

  if (config.transport === "stdio") {
    if (
      safeMcpCommand(config.command) !== config.command ||
      canonicalJson(safeMcpArgs(config.args) ?? []) !== canonicalJson(config.args ?? [])
    ) {
      throw new Error(`MCP server '${record.id}' contains a local path or credential argument.`);
    }

    return;
  }

  const url = new URL(config.url);

  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`MCP server '${record.id}' contains URL credentials or query data.`);
  }
}

export function assertSafeImportedText(label: string, value: string): void {
  if (safeText(value) !== value) throw new Error(`${label} contains unsafe text.`);
}

export function assertSafeImportedRecord(record: PortabilityArchiveRecord): void {
  if (record.type === "server-settings") {
    assertSafeImportedText(
      "Source control custom instructions",
      record.data.sourceControlWritingStyle.customInstructions,
    );

    return;
  }

  if (record.type === "mcp-server") {
    assertSafeImportedText(`MCP server '${record.id}' name`, record.data.configuration.name);

    if (record.data.instructions !== undefined) {
      assertSafeImportedText(`MCP server '${record.id}' instructions`, record.data.instructions);
    }

    assertSafeImportedMcp(record);

    return;
  }

  if (record.type === "bot") {
    assertSafeImportedText(`Bot '${record.id}' name`, record.data.name);
    assertSafeImportedText(`Bot '${record.id}' title`, record.data.title);

    if (record.data.label !== null)
      assertSafeImportedText(`Bot '${record.id}' label`, record.data.label);

    if (record.data.description !== null)
      assertSafeImportedText(`Bot '${record.id}' description`, record.data.description);

    if (record.data.avatar.kind === "image") {
      throw new Error(`Bot '${record.id}' contains an image avatar path.`);
    }

    return;
  }

  if (record.type === "group") {
    assertSafeImportedText(`Group '${record.id}' name`, record.data.name);

    return;
  }

  if (record.type === "project") {
    assertSafeImportedText(`Project '${record.id}' title`, record.data.title);
    assertSafeImportedText(`Project '${record.id}' workspace name`, record.data.workspaceName);

    for (const value of Object.values(record.data.repository ?? {})) {
      if (value !== undefined) assertSafeImportedText(`Project '${record.id}' repository`, value);
    }

    return;
  }

  if (record.type === "thread") {
    assertSafeImportedText(`Chat '${record.id}' title`, record.data.title);

    for (const message of record.data.messages) {
      assertSafeImportedText(`Chat '${record.id}' message`, message.text);
    }

    for (const plan of record.data.proposedPlans) {
      assertSafeImportedText(`Chat '${record.id}' proposed plan`, plan.planMarkdown);
    }

    for (const approval of record.data.approvalHistory) {
      assertSafeImportedText(`Chat '${record.id}' approval summary`, approval.summary);
      assertSafeImportedText(`Chat '${record.id}' approval provider`, approval.provider);

      for (const value of [
        approval.requestId,
        approval.requestKind,
        approval.requestType,
        approval.decision,
        approval.actor,
        approval.target,
        approval.action,
        approval.outcome,
      ]) {
        if (value !== undefined)
          assertSafeImportedText(`Chat '${record.id}' approval field`, value);
      }
    }

    if (
      (record.data.settledOverride === "settled") !== (record.data.settledAt !== null) ||
      (record.data.snoozedUntil === null) !== (record.data.snoozedAt === null)
    ) {
      throw new Error(`Chat '${record.id}' has inconsistent lifecycle timestamps.`);
    }
  }
}

export function parsePortabilityArchive(contents: string) {
  const archive = decodeArchive(JSON.parse(contents));

  const sorted = [...archive.records].sort((left, right) =>
    left.type === right.type
      ? left.id.localeCompare(right.id)
      : left.type.localeCompare(right.type),
  );

  if (archive.records.some((record, index) => record !== sorted[index])) {
    throw new Error("Archive records are not sorted.");
  }

  const keys = new Set<string>();

  for (const record of archive.records) {
    const key = `${record.type}:${record.id}`;

    if (keys.has(key)) throw new Error(`Archive contains duplicate record '${key}'.`);
    keys.add(key);
    const { checksum, ...core } = record;

    if (portabilityChecksum(core) !== checksum) throw new Error(`Checksum failed for '${key}'.`);
    assertSafeImportedRecord(record);
  }

  const { checksum, ...body } = archive;

  if (portabilityChecksum(body) !== checksum) throw new Error("Archive checksum failed.");

  const recordCounts = Object.fromEntries(
    ARCHIVE_RECORD_TYPES.map((type) => [
      type,
      archive.records.filter((record) => record.type === type).length,
    ]),
  );

  if (canonicalJson(archive.manifest.recordCounts) !== canonicalJson(recordCounts)) {
    throw new Error("Archive manifest record counts do not match its records.");
  }

  const botIds = new Set(
    archive.records.filter((record) => record.type === "bot").map((record) => record.id),
  );

  const mcpIds = new Set(
    archive.records.filter((record) => record.type === "mcp-server").map((record) => record.id),
  );

  const projectIds = new Set(
    archive.records.filter((record) => record.type === "project").map((record) => record.id),
  );

  const threadIds = new Set(
    archive.records.filter((record) => record.type === "thread").map((record) => record.id),
  );

  const groupIds = new Set(
    archive.records.filter((record) => record.type === "group").map((record) => record.id),
  );

  for (const record of archive.records) {
    if (record.type === "bot") {
      const missing = record.data.disabledMcpServerIds.find((id) => !mcpIds.has(id));

      if (missing)
        throw new Error(`Bot '${record.id}' references missing MCP server '${missing}'.`);
    }

    if (record.type === "group") {
      const memberIds = record.data.members.map((member) => member.botId);

      if (new Set(memberIds).size !== memberIds.length) {
        throw new Error(`Group '${record.id}' contains duplicate members.`);
      }

      const bosses = record.data.members.filter((member) => member.role === "boss");

      if (
        bosses.length > 1 ||
        (record.data.bossBotId === null && bosses.length !== 0) ||
        (record.data.bossBotId !== null &&
          (bosses.length !== 1 || bosses[0]!.botId !== record.data.bossBotId))
      ) {
        throw new Error(`Group '${record.id}' has inconsistent boss membership.`);
      }

      const referenced = [
        record.data.bossBotId,
        ...record.data.members.map((member) => member.botId),
      ];

      const missing = referenced.find((id) => id !== null && !botIds.has(id));

      if (missing) throw new Error(`Group '${record.id}' references missing bot '${missing}'.`);
    }

    if (record.type === "thread") {
      if (!projectIds.has(record.data.projectId)) {
        throw new Error(
          `Chat '${record.id}' references missing project '${record.data.projectId}'.`,
        );
      }

      if (record.data.botId && !botIds.has(record.data.botId)) {
        throw new Error(`Chat '${record.id}' references missing bot '${record.data.botId}'.`);
      }

      if (record.data.groupId && !groupIds.has(record.data.groupId)) {
        throw new Error(`Chat '${record.id}' references missing group '${record.data.groupId}'.`);
      }

      const missingRespondingBot = record.data.messages.find(
        (message) => message.respondingBotId && !botIds.has(message.respondingBotId),
      )?.respondingBotId;

      if (missingRespondingBot) {
        throw new Error(
          `Chat '${record.id}' message references missing bot '${missingRespondingBot}'.`,
        );
      }

      const missingImplementationThread = record.data.proposedPlans.find(
        (plan) =>
          plan.implementationThreadId !== null && !threadIds.has(plan.implementationThreadId),
      )?.implementationThreadId;

      if (missingImplementationThread) {
        throw new Error(
          `Chat '${record.id}' plan references missing chat '${missingImplementationThread}'.`,
        );
      }
    }
  }

  return archive;
}
