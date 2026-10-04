import * as Predicate from "effect/Predicate";

import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import {
  AKERU_BOT_MEMORY_MAX_CHARS,
  AKERU_GROUP_MEMORY_MAX_CHARS,
  AKERU_USER_MEMORY_MAX_CHARS,
  type AkeruBotMemorySnapshot,
  type AkeruMemoryDocument,
  type AkeruMemoryDocumentTarget,
  type AkeruMemoryFileMutationInput,
  type AkeruMemoryFileMutationResult,
  type BotId,
  type GroupId,
} from "@akeru/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import {
  AKERU_MEMORY_REVIEW_INPUT_MAX_CHARS,
  AKERU_MEMORY_REVIEW_PROMPT_INTERVAL,
} from "./BotMemoryReview.ts";
import { scanMemoryContent } from "./memoryContentSafety.ts";
import {
  NodeFS,
  BotMemoryError,
  type BotMemoryAccess,
  type ResolvedDocument,
  type ReadDocumentResult,
  assertSafeId,
} from "./BotMemoryTypes.ts";
import {
  type BotMemoryReviewCadence,
  type BotMemoryReviewReservation,
  type BotMemoryReviewInput,
  type BotMemoryReviewCadenceState,
  REVIEW_CLAIM_LEASE_MS,
  EMPTY_REVIEW_CADENCE,
  CONSERVATIVE_REVIEW_CADENCE,
  boundReviewInputs,
  InvalidReviewCadenceError,
  parseReviewCadence,
} from "./BotMemoryReviewState.ts";
import {
  parseEntries,
  renderEntries,
  assertSafeContent,
  applyOperation,
} from "./BotMemoryEntries.ts";
import {
  pathExists,
  ensurePrivateDirectory,
  assertNotSymlink,
  assertMemoryPath,
  type BotMemoryFileLock,
  withFileLock,
  writeMemoryFile,
} from "./BotMemoryFileStorage.ts";

const isBotMemoryError = Schema.is(BotMemoryError);

export {
  AKERU_MEMORY_REVIEW_BATCH_MAX_CHARS,
  AKERU_MEMORY_REVIEW_INPUT_MAX_CHARS,
} from "./BotMemoryReview.ts";

export class BotMemoryStore {
  readonly memoryRoot: string;
  private readonly now: () => number;
  private readonly reviewClaimLeaseMs: number;
  constructor(
    stateDir: string,
    options: { readonly now?: () => number; readonly reviewClaimLeaseMs?: number } = {},
  ) {
    this.memoryRoot = NodePath.join(stateDir, "memory");
    this.now = options.now ?? (() => DateTime.toEpochMillis(DateTime.nowUnsafe()));
    this.reviewClaimLeaseMs = options.reviewClaimLeaseMs ?? REVIEW_CLAIM_LEASE_MS;
  }

  private reviewCadencePath(botId: BotId, groupId: string | null): string {
    assertSafeId("Bot ID", botId);

    if (groupId === null)
      return NodePath.join(this.memoryRoot, "bots", botId, ".memory-review.json");
    assertSafeId("Group ID", groupId);

    return NodePath.join(this.memoryRoot, "bots", botId, "groups", groupId, ".memory-review.json");
  }

  private async readReviewCadenceState(filePath: string): Promise<BotMemoryReviewCadenceState> {
    await assertMemoryPath(this.memoryRoot, filePath);
    await assertNotSymlink(filePath);

    try {
      return parseReviewCadence(await NodeFS.readFile(filePath, "utf8"));
    } catch (cause) {
      if ((Predicate.hasProperty(cause, "code") ? cause.code : undefined) === "ENOENT")
        return EMPTY_REVIEW_CADENCE;

      if (isBotMemoryError(cause) || cause instanceof InvalidReviewCadenceError) throw cause;
      throw BotMemoryError.fromCode("io-error", "Could not read the bot memory review cadence.", {
        cause,
      });
    }
  }

  private async readReviewCadenceStateRecovering(
    filePath: string,
    lock: BotMemoryFileLock,
  ): Promise<BotMemoryReviewCadenceState> {
    try {
      return await this.readReviewCadenceState(filePath);
    } catch (cause) {
      if (!(cause instanceof InvalidReviewCadenceError)) throw cause;

      const quarantinePath = NodePath.join(
        NodePath.dirname(filePath),
        `.memory-review.corrupt-${DateTime.formatIso(DateTime.nowUnsafe()).replaceAll(":", "-")}-${NodeCrypto.randomUUID()}.json`,
      );

      await assertMemoryPath(this.memoryRoot, quarantinePath);
      await lock.verifyOwnership();
      await NodeFS.rename(filePath, quarantinePath);
      await NodeFS.chmod(quarantinePath, 0o600);
      await writeMemoryFile(
        this.memoryRoot,
        filePath,
        `${JSON.stringify(CONSERVATIVE_REVIEW_CADENCE)}\n`,
        lock.verifyOwnership,
      );

      return CONSERVATIVE_REVIEW_CADENCE;
    }
  }

  private toReviewCadence(state: BotMemoryReviewCadenceState): BotMemoryReviewCadence {
    return {
      acceptedPromptCount: state.acceptedPromptCount,
      reviewedThroughPromptCount: state.reviewedThroughPromptCount,
      dueOnNextAcceptedPrompt:
        state.acceptedPromptCount - state.reviewedThroughPromptCount >=
        AKERU_MEMORY_REVIEW_PROMPT_INTERVAL,
    };
  }

  async readReviewCadence(
    botId: BotId,
    groupId: string | null = null,
  ): Promise<BotMemoryReviewCadence> {
    const filePath = this.reviewCadencePath(botId, groupId);

    return withFileLock(this.memoryRoot, filePath, async (lock) =>
      this.toReviewCadence(await this.readReviewCadenceStateRecovering(filePath, lock)),
    );
  }

  async reserveReviewCadence(
    botId: BotId,
    reviewInput?: BotMemoryReviewInput,
  ): Promise<BotMemoryReviewReservation> {
    const groupId = reviewInput?.groupId ?? null;
    const filePath = this.reviewCadencePath(botId, groupId);

    return withFileLock(this.memoryRoot, filePath, async (lock) => {
      const state = await this.readReviewCadenceStateRecovering(filePath, lock);
      const now = this.now();
      const due = this.toReviewCadence(state).dueOnNextAcceptedPrompt;
      const claimAvailable = !state.reviewClaim || state.reviewClaim.leaseExpiresAtMs <= now;
      const id = NodeCrypto.randomUUID();
      const memoryReviewIncluded = due && claimAvailable;

      if (memoryReviewIncluded) {
        const inputIds = state.reviewInputs.flatMap((input) => (input.id ? [input.id] : []));
        await writeMemoryFile(
          this.memoryRoot,
          filePath,
          `${JSON.stringify({
            ...state,
            reviewClaim: {
              id,
              acquiredAtMs: now,
              leaseExpiresAtMs: now + this.reviewClaimLeaseMs,
              throughPromptCount: state.acceptedPromptCount,
              inputIds,
            },
          })}\n`,
          lock.verifyOwnership,
        );
      }

      return {
        id,
        botId,
        groupId,
        memoryReviewIncluded,
        reviewInputs: memoryReviewIncluded ? state.reviewInputs : [],
        ...(reviewInput
          ? {
              pendingInput: {
                ...reviewInput,
                id: reviewInput.id ?? NodeCrypto.randomUUID(),
                text: reviewInput.text.slice(0, AKERU_MEMORY_REVIEW_INPUT_MAX_CHARS),
              },
            }
          : {}),
      };
    });
  }

  async settleReviewCadence(
    reservation: BotMemoryReviewReservation,
    accepted: boolean,
    reviewCompleted = accepted,
  ): Promise<BotMemoryReviewCadence> {
    if (accepted) await this.recordSuccessfulPrompt(reservation);

    if (reservation.memoryReviewIncluded) {
      return this.settleReviewClaim(reservation, reviewCompleted);
    }

    return this.readReviewCadence(reservation.botId, reservation.groupId);
  }

  async recordSuccessfulPrompt(
    reservation: BotMemoryReviewReservation,
  ): Promise<BotMemoryReviewCadence> {
    const filePath = this.reviewCadencePath(reservation.botId, reservation.groupId);

    return withFileLock(this.memoryRoot, filePath, async (lock) => {
      const before = await this.readReviewCadenceStateRecovering(filePath, lock);

      if (before.settledTurnIds?.includes(reservation.id)) return this.toReviewCadence(before);

      const next: BotMemoryReviewCadenceState = {
        ...before,
        acceptedPromptCount: before.acceptedPromptCount + 1,
        reviewInputs: reservation.pendingInput
          ? boundReviewInputs([...before.reviewInputs, reservation.pendingInput])
          : before.reviewInputs,
        settledTurnIds: [...(before.settledTurnIds ?? []), reservation.id].slice(-20),
      };

      await writeMemoryFile(
        this.memoryRoot,
        filePath,
        `${JSON.stringify(next)}\n`,
        lock.verifyOwnership,
      );

      return this.toReviewCadence(next);
    });
  }

  async settleReviewClaim(
    reservation: BotMemoryReviewReservation,
    completed: boolean,
  ): Promise<BotMemoryReviewCadence> {
    const filePath = this.reviewCadencePath(reservation.botId, reservation.groupId);

    return withFileLock(this.memoryRoot, filePath, async (lock) => {
      const before = await this.readReviewCadenceStateRecovering(filePath, lock);

      if (before.reviewClaim?.id !== reservation.id) return this.toReviewCadence(before);
      const claimedIds = new Set(before.reviewClaim.inputIds);

      const { reviewClaim: _reviewClaim, ...withoutClaim } = before;

      const next: BotMemoryReviewCadenceState = {
        ...withoutClaim,
        reviewedThroughPromptCount: completed
          ? Math.max(before.reviewedThroughPromptCount, before.reviewClaim.throughPromptCount)
          : before.reviewedThroughPromptCount,
        reviewInputs: completed
          ? before.reviewInputs.filter((input) => !input.id || !claimedIds.has(input.id))
          : before.reviewInputs,
      };

      await writeMemoryFile(
        this.memoryRoot,
        filePath,
        `${JSON.stringify(next)}\n`,
        lock.verifyOwnership,
      );

      return this.toReviewCadence(next);
    });
  }

  async renewReviewClaim(reservation: BotMemoryReviewReservation): Promise<boolean> {
    if (!reservation.memoryReviewIncluded) return false;
    const filePath = this.reviewCadencePath(reservation.botId, reservation.groupId);

    return withFileLock(this.memoryRoot, filePath, async (lock) => {
      const before = await this.readReviewCadenceStateRecovering(filePath, lock);

      if (before.reviewClaim?.id !== reservation.id) return false;
      const now = this.now();

      const next: BotMemoryReviewCadenceState = {
        ...before,
        reviewClaim: {
          ...before.reviewClaim,
          acquiredAtMs: now,
          leaseExpiresAtMs: now + this.reviewClaimLeaseMs,
        },
      };

      await writeMemoryFile(
        this.memoryRoot,
        filePath,
        `${JSON.stringify(next)}\n`,
        lock.verifyOwnership,
      );

      return true;
    });
  }

  private resolve(access: BotMemoryAccess, target: AkeruMemoryDocumentTarget): ResolvedDocument {
    assertSafeId("Bot ID", access.botId);
    const botDirectory = NodePath.join(this.memoryRoot, "bots", access.botId);

    if (target === "user") {
      return {
        target,
        filePath: NodePath.join(botDirectory, "USER.md"),
        charLimit: AKERU_USER_MEMORY_MAX_CHARS,
        memoryRoot: this.memoryRoot,
      };
    }

    if (target === "memory") {
      return {
        target,
        filePath: NodePath.join(botDirectory, "MEMORY.md"),
        charLimit: AKERU_BOT_MEMORY_MAX_CHARS,
        memoryRoot: this.memoryRoot,
      };
    }

    if (
      access.groupId === null ||
      !access.groupMemberBotIds.some((memberBotId) => memberBotId === access.botId)
    ) {
      throw BotMemoryError.fromCode(
        "access-denied",
        "Group memory is available only while the responding bot is a current group member.",
      );
    }

    assertSafeId("Group ID", access.groupId);

    return {
      target,
      filePath: NodePath.join(botDirectory, "groups", access.groupId, "GROUP.md"),
      charLimit: AKERU_GROUP_MEMORY_MAX_CHARS,
      memoryRoot: this.memoryRoot,
    };
  }

  private async readResolved(document: ResolvedDocument): Promise<ReadDocumentResult> {
    await assertMemoryPath(this.memoryRoot, document.filePath);
    await assertNotSymlink(document.filePath);

    try {
      const bytes = await NodeFS.readFile(document.filePath);
      const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      const stat = await NodeFS.stat(document.filePath);

      return { entries: parseEntries(content), updatedAt: stat.mtime.toISOString() };
    } catch (cause) {
      if ((Predicate.hasProperty(cause, "code") ? cause.code : undefined) === "ENOENT") {
        return { entries: [], updatedAt: null };
      }

      if (isBotMemoryError(cause)) throw cause;
      throw BotMemoryError.fromCode(
        "io-error",
        "Could not read the memory file without data loss.",
        {
          cause,
        },
      );
    }
  }

  private toDocument(resolved: ResolvedDocument, value: ReadDocumentResult): AkeruMemoryDocument {
    const content = renderEntries(value.entries);

    return {
      target: resolved.target,
      content,
      charCount: content.length,
      charLimit: resolved.charLimit,
      updatedAt: value.updatedAt,
    };
  }

  async readDocument(
    access: BotMemoryAccess,
    target: AkeruMemoryDocumentTarget,
  ): Promise<AkeruMemoryDocument> {
    const resolved = this.resolve(access, target);

    return this.toDocument(resolved, await this.readResolved(resolved));
  }

  async readSnapshot(access: BotMemoryAccess): Promise<AkeruBotMemorySnapshot> {
    const [user, memory, group] = await Promise.all([
      this.readDocument(access, "user"),
      this.readDocument(access, "memory"),
      access.groupId === null ? Promise.resolve(null) : this.readDocument(access, "group"),
    ]);

    return { botId: access.botId, groupId: access.groupId, user, memory, group };
  }

  async mutate(input: AkeruMemoryFileMutationInput): Promise<AkeruMemoryFileMutationResult> {
    const access: BotMemoryAccess = input;
    const resolved = this.resolve(access, input.target);

    if (input.operations.length === 0) {
      throw BotMemoryError.fromCode(
        "invalid-operation",
        "At least one memory operation is required.",
      );
    }

    return withFileLock(this.memoryRoot, resolved.filePath, async (lock) => {
      const before = await this.readResolved(resolved);
      let entries = before.entries;

      for (const operation of input.operations) entries = applyOperation(entries, operation);
      const content = renderEntries(entries);

      if (content.length > resolved.charLimit) {
        throw BotMemoryError.fromCode(
          "limit-exceeded",
          `${NodePath.basename(resolved.filePath)} would exceed its ${resolved.charLimit.toLocaleString()} character limit.`,
          {
            charCount: content.length,
            charLimit: resolved.charLimit,
            currentEntries: before.entries,
          },
        );
      }

      const changed = content !== renderEntries(before.entries);

      if (changed)
        await writeMemoryFile(this.memoryRoot, resolved.filePath, content, lock.verifyOwnership);
      const updated = changed ? await this.readResolved(resolved) : before;

      return {
        document: this.toDocument(resolved, updated),
        applied: input.operations.length,
        changed,
      };
    });
  }

  async replaceDocument(
    access: BotMemoryAccess,
    target: AkeruMemoryDocumentTarget,
    content: string,
    expectedBotId: BotId = access.botId,
    expectedContent?: string,
  ): Promise<AkeruMemoryDocument> {
    if (access.botId !== expectedBotId) {
      throw BotMemoryError.fromCode(
        "access-denied",
        "The active bot changed. Reopen memory before saving.",
      );
    }

    const resolved = this.resolve(access, target);
    const { normalized } = this.validateDocumentReplacement(access, target, content);

    return withFileLock(this.memoryRoot, resolved.filePath, async (lock) => {
      const before = await this.readResolved(resolved);

      if (expectedContent !== undefined && expectedContent !== renderEntries(before.entries)) {
        throw BotMemoryError.fromCode(
          "invalid-operation",
          "Memory changed since you opened it. Reopen memory before saving.",
        );
      }

      if (normalized !== renderEntries(before.entries)) {
        await writeMemoryFile(this.memoryRoot, resolved.filePath, normalized, lock.verifyOwnership);

        return this.toDocument(resolved, await this.readResolved(resolved));
      }

      return this.toDocument(resolved, before);
    });
  }

  async withDocumentTransaction<A>(
    access: BotMemoryAccess,
    use: (
      replace: (target: AkeruMemoryDocumentTarget, content: string) => Promise<void>,
    ) => Promise<A>,
  ): Promise<A> {
    const targets: AkeruMemoryDocumentTarget[] = [
      "user",
      "memory",
      ...(access.groupId === null ? [] : ["group" as const]),
    ];

    const documents = targets
      .map((target) => this.resolve(access, target))
      .sort((a, b) => a.filePath.localeCompare(b.filePath));

    const locks = new Map<string, BotMemoryFileLock>();

    const lock = async (index: number): Promise<A> => {
      const document = documents[index];

      if (document)
        return withFileLock(this.memoryRoot, document.filePath, async (held) => {
          locks.set(document.filePath, held);

          return lock(index + 1);
        });

      const originals = new Map<
        AkeruMemoryDocumentTarget,
        { readonly resolved: ResolvedDocument; readonly content: string | null }
      >();

      for (const resolved of documents) {
        await this.readResolved(resolved);

        const content = await NodeFS.readFile(resolved.filePath, "utf8").catch(
          (cause: NodeJS.ErrnoException) => {
            if (cause.code === "ENOENT") return null;
            throw cause;
          },
        );

        originals.set(resolved.target, { resolved, content });
      }

      const touched = new Set<AkeruMemoryDocumentTarget>();

      try {
        return await use(async (target, content) => {
          const original = originals.get(target);

          if (!original)
            throw BotMemoryError.fromCode(
              "access-denied",
              "Memory target is outside this transaction.",
            );
          const { normalized } = this.validateDocumentReplacement(access, target, content);
          touched.add(target);
          await writeMemoryFile(
            this.memoryRoot,
            original.resolved.filePath,
            normalized,
            locks.get(original.resolved.filePath)?.verifyOwnership,
          );
        });
      } catch (cause) {
        const failures: unknown[] = [];

        for (const target of touched) {
          const original = originals.get(target)!;

          try {
            if (original.content === null)
              await NodeFS.rm(original.resolved.filePath, { force: true });
            else
              await writeMemoryFile(
                this.memoryRoot,
                original.resolved.filePath,
                original.content,
                locks.get(original.resolved.filePath)?.verifyOwnership,
              );
          } catch (rollbackCause) {
            failures.push(rollbackCause);
          }
        }

        if (failures.length > 0)
          throw Object.assign(
            new Error("Memory import failed and its original files could not all be restored.", {
              cause,
            }),
            { rollbackErrors: failures },
          );
        throw cause;
      }
    };

    return lock(0);
  }

  validateDocumentReplacement(
    access: BotMemoryAccess,
    target: AkeruMemoryDocumentTarget,
    content: string,
  ): ValidateDocumentReplacementResult {
    const resolved = this.resolve(access, target);
    const normalized = renderEntries(parseEntries(content.replaceAll("\r\n", "\n")));
    assertSafeContent(normalized);

    if (normalized.length > resolved.charLimit) {
      throw BotMemoryError.fromCode(
        "limit-exceeded",
        `${NodePath.basename(resolved.filePath)} exceeds its ${resolved.charLimit.toLocaleString()} character limit.`,
        { charCount: normalized.length, charLimit: resolved.charLimit },
      );
    }

    return { normalized, charLimit: resolved.charLimit };
  }

  async readPromptSnapshot(access: BotMemoryAccess): Promise<AkeruBotMemorySnapshot> {
    const snapshot = await this.readSnapshot(access);

    const sanitize = (document: AkeruMemoryDocument): AkeruMemoryDocument => {
      const blockedForSize = (): AkeruMemoryDocument => {
        const content = `[BLOCKED: ${document.target.toUpperCase()} memory exceeds its ${document.charLimit} character prompt limit. Shorten the memory file before using it.]`;

        return { ...document, content, charCount: content.length };
      };

      if (document.content.length > document.charLimit) return blockedForSize();

      const entries = parseEntries(document.content).map((entry) => {
        const findings = scanMemoryContent(entry);

        return findings.length === 0
          ? entry
          : `[BLOCKED: ${document.target.toUpperCase()} memory contained ${findings.join(", ")}. Edit the memory file to remove it.]`;
      });

      const content = renderEntries(entries);

      return content.length > document.charLimit
        ? blockedForSize()
        : { ...document, content, charCount: content.length };
    };

    return {
      ...snapshot,
      user: sanitize(snapshot.user),
      memory: sanitize(snapshot.memory),
      group: snapshot.group === null ? null : sanitize(snapshot.group),
    };
  }

  async archiveGroup(botId: BotId, groupId: GroupId): Promise<string | null> {
    const access = { botId, groupId, groupMemberBotIds: [botId] };
    const source = this.resolve(access, "group").filePath;
    await assertMemoryPath(this.memoryRoot, source);

    if (!(await pathExists(source))) return null;

    const archiveDirectory = NodePath.join(
      this.memoryRoot,
      "archive",
      "bots",
      botId,
      "groups",
      groupId,
    );

    await ensurePrivateDirectory(this.memoryRoot, archiveDirectory);

    const destination = NodePath.join(
      archiveDirectory,
      `${DateTime.formatIso(DateTime.nowUnsafe()).replaceAll(":", "-")}-${NodeCrypto.randomUUID()}.md`,
    );

    await withFileLock(this.memoryRoot, source, async (lock) => {
      await lock.verifyOwnership();
      await NodeFS.rename(source, destination);
    });

    return destination;
  }

  async runMigrationOnce(
    botId: BotId,
    migrationKey: string,
    migrate: () => Promise<void>,
  ): Promise<boolean> {
    assertSafeId("Bot ID", botId);
    assertSafeId("Migration key", migrationKey);

    const markerPath = NodePath.join(
      this.memoryRoot,
      "bots",
      botId,
      ".migrations",
      `${migrationKey}.done`,
    );

    return withFileLock(this.memoryRoot, markerPath, async (lock) => {
      if (await pathExists(markerPath)) return false;
      await migrate();
      await writeMemoryFile(
        this.memoryRoot,
        markerPath,
        DateTime.formatIso(DateTime.nowUnsafe()),
        lock.verifyOwnership,
      );

      return true;
    });
  }

  async isMigrationComplete(botId: BotId, migrationKey: string): Promise<boolean> {
    assertSafeId("Bot ID", botId);
    assertSafeId("Migration key", migrationKey);

    const markerPath = NodePath.join(
      this.memoryRoot,
      "bots",
      botId,
      ".migrations",
      `${migrationKey}.done`,
    );

    await assertMemoryPath(this.memoryRoot, markerPath);

    return pathExists(markerPath);
  }

  async writeMigrationArchive(
    botId: BotId,
    migrationKey: string,
    content: string,
  ): Promise<string> {
    assertSafeId("Bot ID", botId);
    assertSafeId("Migration key", migrationKey);

    const archivePath = NodePath.join(
      this.memoryRoot,
      "migration-archive",
      "bots",
      botId,
      `${migrationKey}.md`,
    );

    await writeMemoryFile(this.memoryRoot, archivePath, content);

    return archivePath;
  }
}

export { BOT_MEMORY_ENTRY_DELIMITER } from "./BotMemoryEntries.ts";

export type { BotMemoryErrorCode } from "./BotMemoryTypes.ts";

export { BotMemoryError } from "./BotMemoryTypes.ts";

export { makeBotMemoryError } from "./BotMemoryTypes.ts";

export { toBotMemoryError } from "./BotMemoryTypes.ts";

export type { BotMemoryAccess } from "./BotMemoryTypes.ts";

export { formatBotMemoryPrompt } from "./BotMemoryEntries.ts";

export type { BotMemoryReviewCadence } from "./BotMemoryReviewState.ts";

export type { BotMemoryReviewReservation } from "./BotMemoryReviewState.ts";

export type { BotMemoryReviewInput } from "./BotMemoryReviewState.ts";

export { assertSafeContent } from "./BotMemoryEntries.ts";

export { acquireBotMemoryFileLock } from "./BotMemoryFileStorage.ts";

type ValidateDocumentReplacementResult = {
  readonly normalized: string;
  readonly charLimit: number;
};
