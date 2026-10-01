// @effect-diagnostics globalDate:off globalFetch:off globalFetchInEffect:off nodeBuiltinImport:off preferSchemaOverJson:off
import {
  AkeruMemoryEntityId,
  AkeruMemoryId,
  AkeruMemoryPartitionId,
  AkeruMemoryRootId,
  AkeruMemoryTenantId,
  AkeruMemoryUserId,
  BotId,
  EnvironmentId,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  TurnId,
  type AkeruMemoryRevision,
} from "@akeru/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";
import * as McpMemoryToolSession from "../../../mcp/McpMemoryToolSession.ts";
import type { McpCapability } from "../../../mcp/McpInvocationContext.ts";
import type { ProviderServiceShape } from "../../Services/ProviderService.ts";
import { BotUsageLedger, type BotUsageLedgerShape } from "../../../usage/BotUsageLedger.ts";

export class MemoryToolCallError extends Data.TaggedError("MemoryToolCallError")<{
  readonly cause: Error;
}> {}

export function completeLegacyTurnWithMemoryReview(
  input: Parameters<ProviderServiceShape["sendTurn"]>[0],
  turnId: TurnId,
  successfulMemoryCalls = 1,
) {
  return Effect.promise(async () => {
    if (input.persistentMemoryContext?.includes("<automatic-memory-review>")) {
      const handler = McpMemoryToolSession.readMcpMemoryToolSession(input.threadId);
      if (!handler) throw new Error("Foreground memory review handler was not registered.");
      for (let call = 0; call < successfulMemoryCalls; call += 1) {
        await handler({
          threadId: String(input.threadId),
          toolId: "memory",
          toolCallId: `foreground-memory-review-${String(turnId)}-${call}`,
          input: { target: "user", operations: [] },
          approvalMode: "require-grant",
        });
      }
    }
    return { threadId: input.threadId, turnId };
  });
}

export function privatePolicyRevisions(
  botId: BotId,
  projectId: ProjectId,
): Array<AkeruMemoryRevision> {
  const revision = (scope: AkeruMemoryRevision["partition"]["scope"], fact: string) =>
    ({
      id: AkeruMemoryId.make(`memory-${scope}`),
      rootId: AkeruMemoryRootId.make(`memory-${scope}`),
      revision: 1,
      partition: {
        tenantId: AkeruMemoryTenantId.make("local"),
        scope,
        partitionId: AkeruMemoryPartitionId.make(`${scope}-partition`),
      },
      entityKind: scope === "project" ? "project" : "bot",
      entityId: AkeruMemoryEntityId.make(scope === "project" ? String(projectId) : String(botId)),
      kind: "fact",
      value: {},
      fact,
      sourceThreadId: null,
      sourceMessageId: null,
      authorBotId: botId,
      initiatingUserId: AkeruMemoryUserId.make("owner"),
      createdAt: "2026-09-01T00:00:00.000Z",
      confirmedAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      confidence: 0.5,
      approvalState: "approved",
      supersedesId: null,
      supersededById: null,
      visibility: scope === "project" ? "shared" : "private",
      deletionState: "active",
      pinned: false,
      sensitive: false,
      affectedBotIds: [botId],
    }) as AkeruMemoryRevision;
  return [
    revision("bot", "Bot-private entity fact."),
    revision("bot-user", "Bot-about-you entity fact."),
    revision("project", "Shared project entity fact."),
  ];
}

export function entityMemorySection(context: unknown): string {
  const match = /<entity-memory>[\s\S]*?<\/entity-memory>/u.exec(String(context ?? ""));
  return match?.[0] ?? "";
}

export function makeMemoryOnlyCredentialOptions() {
  const requests: Array<{
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly capabilities?: ReadonlySet<McpCapability>;
  }> = [];
  const revoked: Array<ThreadId> = [];
  return {
    requests,
    revoked,
    issueMcpCredential: (request: (typeof requests)[number]) => {
      requests.push(request);
      if (!request.capabilities?.has("memory")) return Effect.succeed(undefined);
      return Effect.succeed({
        config: {
          environmentId: EnvironmentId.make("environment-test"),
          threadId: request.threadId,
          providerSessionId: `session-${String(request.threadId)}`,
          providerInstanceId: request.providerInstanceId,
          endpoint: "http://127.0.0.1:1/mcp",
          authorizationHeader: "Bearer test-memory-only",
        },
      });
    },
    revokeMcpCredential: (threadId: ThreadId) =>
      Effect.sync(() => {
        revoked.push(threadId);
      }),
  };
}

export function makeUsageLedger() {
  const reserve = vi.fn<BotUsageLedgerShape["reserve"]>(() => Effect.succeed({} as never));
  const settle = vi.fn<BotUsageLedgerShape["settle"]>(() => Effect.succeed({} as never));
  const recordMeasurement = vi.fn<BotUsageLedgerShape["recordMeasurement"]>(() =>
    Effect.succeed({} as never),
  );
  const recordStart = vi.fn<BotUsageLedgerShape["recordStart"]>(() => Effect.succeed({} as never));
  const unused = () => Effect.die("unused");
  return {
    reserve,
    settle,
    recordMeasurement,
    recordStart,
    service: BotUsageLedger.of({
      reserve,
      settle,
      bindTurn: unused,
      settleForTurn: unused,
      finalizeForTurn: unused,
      recordMeasurement,
      recordStart,
      summarize: unused,
      pricingTotals: unused,
    }),
  };
}
