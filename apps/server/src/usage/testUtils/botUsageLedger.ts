import { AkeruUsageReservationId, BotId, ProviderDriverKind, ThreadId } from "@akeru/contracts";
import * as Layer from "effect/Layer";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { BotUsageLedgerLive, type ReserveBotUsageInput } from "../BotUsageLedger.ts";

const layer = BotUsageLedgerLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));

const reserveInput = (
  reservationId: string,
  overrides: Partial<ReserveBotUsageInput> = {},
): ReserveBotUsageInput => ({
  reservationId: AkeruUsageReservationId.make(reservationId),
  sourceKey: `turn-start:${reservationId}`,
  botId: BotId.make("bot-1"),
  threadId: ThreadId.make("thread-1"),
  turnId: null,
  category: "turn",
  maximumTokens: 1_000,
  capLimit: 1_000,
  provider: ProviderDriverKind.make("codex"),
  model: "gpt-5.6-sol",
  createdAt: "2026-08-30T20:00:00.000Z",
  ...overrides,
});
export { layer, reserveInput };
