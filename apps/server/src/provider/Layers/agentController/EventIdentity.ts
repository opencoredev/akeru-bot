// @effect-diagnostics globalDate:off globalConsole:off globalRandom:off nodeBuiltinImport:off globalTimers:off globalFetch:off
import * as NodeCrypto from "node:crypto";
import { EventId } from "@akeru/contracts";

export function nowIso(): string {
  return new Date().toISOString();
}

export function eventId(): EventId {
  return EventId.make(`mastra-${NodeCrypto.randomUUID()}`);
}
