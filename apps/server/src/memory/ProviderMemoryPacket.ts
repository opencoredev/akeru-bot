import {
  AKERU_MEMORY_PACKET_MAX_CHARS,
  AKERU_MEMORY_PACKET_MAX_ESTIMATED_TOKENS,
  AKERU_MEMORY_PACKET_MAX_FACTS,
  AkeruMemoryPacket,
  type AkeruMemoryPacket as MemoryPacket,
  type AkeruMemoryRevision,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { scanMemoryContent } from "./memoryContentSafety.ts";

/**
 * Build the provider input from the durable current revisions.
 *
 * Providers must receive this value, rather than assembling their own memory
 * prompt. Keeping ordering and truncation here makes the Mastra and legacy
 * transports byte-for-byte equivalent and means a tombstone is observed on
 * the next read automatically.
 */
export function buildProviderMemoryPacket(
  threadId: ThreadId,
  revisions: ReadonlyArray<AkeruMemoryRevision>,
): MemoryPacket {
  const candidates = revisions
    .filter(
      (revision) => revision.approvalState === "approved" && revision.deletionState === "active",
    )
    .toSorted(
      (left, right) =>
        Number(right.pinned) - Number(left.pinned) ||
        right.confidence - left.confidence ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        String(left.rootId).localeCompare(String(right.rootId)),
    );

  type PacketFact = MemoryPacket["facts"][number];
  const facts: PacketFact[] = [];
  let rendered = "";
  let estimatedTokens = 0;
  for (const revision of candidates) {
    if (facts.length >= AKERU_MEMORY_PACKET_MAX_FACTS) break;
    if (scanMemoryContent(revision.fact).length > 0) continue;
    const fact = {
      memoryId: revision.rootId,
      expectedRevision: revision.revision,
      scope: revision.partition.scope,
      kind: revision.kind,
      fact: revision.fact,
      pinned: revision.pinned,
      confidence: revision.confidence,
      updatedAt: revision.updatedAt,
    } satisfies MemoryPacket["facts"][number];
    const line = `- [${fact.scope}/${fact.kind}] ${fact.fact}`;
    const nextRendered = rendered.length === 0 ? line : `${rendered}\n${line}`;
    const nextTokens = Math.ceil(nextRendered.length / 4);
    if (
      nextRendered.length > AKERU_MEMORY_PACKET_MAX_CHARS ||
      nextTokens > AKERU_MEMORY_PACKET_MAX_ESTIMATED_TOKENS
    ) {
      // A long fact must not hide smaller lower-ranked facts that still fit.
      continue;
    }
    facts.push(fact);
    rendered = nextRendered;
    estimatedTokens = nextTokens;
  }

  return Schema.decodeUnknownSync(AkeruMemoryPacket)({
    threadId,
    facts,
    estimatedTokens,
    rendered,
  });
}
