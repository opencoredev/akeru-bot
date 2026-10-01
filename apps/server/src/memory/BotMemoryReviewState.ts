import { type BotId } from "@akeru/contracts";
import {
  AKERU_MEMORY_REVIEW_BATCH_MAX_CHARS,
  AKERU_MEMORY_REVIEW_INPUT_MAX_CHARS,
  AKERU_MEMORY_REVIEW_PROMPT_INTERVAL,
} from "./BotMemoryReview.ts";

export interface BotMemoryReviewCadence {
  readonly acceptedPromptCount: number;
  readonly reviewedThroughPromptCount: number;
  readonly dueOnNextAcceptedPrompt: boolean;
}

export interface BotMemoryReviewReservation {
  readonly id: string;
  readonly botId: BotId;
  readonly groupId: string | null;
  /** @deprecated Review claims no longer use process ownership. */
  readonly ownerToken?: string;
  readonly memoryReviewIncluded: boolean;
  readonly reviewInputs: ReadonlyArray<BotMemoryReviewInput>;
  readonly pendingInput?: BotMemoryReviewInput;
}

export interface BotMemoryReviewInput {
  readonly id?: string;
  readonly threadId: string;
  readonly groupId: string | null;
  readonly text: string;
}

export interface BotMemoryReviewCadenceState {
  readonly acceptedPromptCount: number;
  readonly reviewedThroughPromptCount: number;
  readonly reviewInputs: ReadonlyArray<BotMemoryReviewInput>;
  readonly settledTurnIds?: ReadonlyArray<string>;
  readonly reviewClaim?: {
    readonly id: string;
    readonly acquiredAtMs: number;
    readonly leaseExpiresAtMs: number;
    readonly throughPromptCount: number;
    readonly inputIds: ReadonlyArray<string>;
  };
}

export const REVIEW_CLAIM_LEASE_MS = 60_000;

export const EMPTY_REVIEW_CADENCE: BotMemoryReviewCadenceState = {
  acceptedPromptCount: 0,
  reviewedThroughPromptCount: 0,
  reviewInputs: [],
};

export const CONSERVATIVE_REVIEW_CADENCE: BotMemoryReviewCadenceState = {
  acceptedPromptCount: AKERU_MEMORY_REVIEW_PROMPT_INTERVAL,
  reviewedThroughPromptCount: 0,
  reviewInputs: [],
};

export function boundReviewInputs(
  inputs: ReadonlyArray<BotMemoryReviewInput>,
): ReadonlyArray<BotMemoryReviewInput> {
  const kept: BotMemoryReviewInput[] = [];

  for (const input of inputs.toReversed()) {
    const bounded = { ...input, text: input.text.slice(0, AKERU_MEMORY_REVIEW_INPUT_MAX_CHARS) };

    if (
      kept.length >= AKERU_MEMORY_REVIEW_PROMPT_INTERVAL ||
      JSON.stringify([bounded, ...kept]).length > AKERU_MEMORY_REVIEW_BATCH_MAX_CHARS
    )
      continue;
    kept.unshift(bounded);
  }

  return kept;
}

export function parseReviewInput(value: unknown): BotMemoryReviewInput {
  const entry = value as Record<string, unknown>;

  if (
    typeof value !== "object" ||
    value === null ||
    !(typeof entry.id === "string" || entry.id === undefined) ||
    typeof entry.threadId !== "string" ||
    !(typeof entry.groupId === "string" || entry.groupId === null) ||
    typeof entry.text !== "string"
  ) {
    throw new InvalidReviewCadenceError("A review input is invalid.");
  }

  return {
    ...(entry.id ? { id: entry.id } : {}),
    threadId: entry.threadId,
    groupId: entry.groupId,
    text: entry.text,
  };
}

export function parseReviewInputs(value: unknown): ReadonlyArray<BotMemoryReviewInput> {
  if (value === undefined) return [];

  if (!Array.isArray(value)) throw new InvalidReviewCadenceError("Review inputs are invalid.");

  return value.map(parseReviewInput);
}

export class InvalidReviewCadenceError extends Error {}

export function parseReviewCadence(raw: string): BotMemoryReviewCadenceState {
  try {
    const value = JSON.parse(raw) as Partial<BotMemoryReviewCadenceState>;

    if (
      Number.isSafeInteger(value.acceptedPromptCount) &&
      Number.isSafeInteger(value.reviewedThroughPromptCount) &&
      value.acceptedPromptCount! >= 0 &&
      value.reviewedThroughPromptCount! >= 0 &&
      value.reviewedThroughPromptCount! <= value.acceptedPromptCount!
    ) {
      return {
        acceptedPromptCount: value.acceptedPromptCount!,
        reviewedThroughPromptCount: value.reviewedThroughPromptCount!,
        reviewInputs: parseReviewInputs(value.reviewInputs),
        ...(Array.isArray(value.settledTurnIds) &&
        value.settledTurnIds.every((id) => typeof id === "string")
          ? { settledTurnIds: value.settledTurnIds }
          : value.settledTurnIds === undefined
            ? {}
            : (() => {
                throw new InvalidReviewCadenceError("Settled turn IDs are invalid.");
              })()),
        ...(typeof value.reviewClaim === "object" &&
        value.reviewClaim !== null &&
        typeof value.reviewClaim.id === "string" &&
        Number.isSafeInteger(value.reviewClaim.acquiredAtMs) &&
        value.reviewClaim.acquiredAtMs >= 0 &&
        Number.isSafeInteger(value.reviewClaim.leaseExpiresAtMs) &&
        value.reviewClaim.leaseExpiresAtMs >= value.reviewClaim.acquiredAtMs &&
        Number.isSafeInteger(value.reviewClaim.throughPromptCount) &&
        value.reviewClaim.throughPromptCount >= 0 &&
        Array.isArray(value.reviewClaim.inputIds) &&
        value.reviewClaim.inputIds.every((id) => typeof id === "string")
          ? { reviewClaim: value.reviewClaim }
          : value.reviewClaim === undefined
            ? {}
            : (() => {
                throw new InvalidReviewCadenceError("The bot memory review claim is invalid.");
              })()),
      };
    }
  } catch {
    // The error below includes the stable public failure shape.
  }

  throw new InvalidReviewCadenceError("The bot memory review cadence file is invalid.");
}
