import * as Schema from "effect/Schema";
import * as Exit from "effect/Exit";
import { flow } from "effect/Function";
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

export class InvalidReviewCadenceError extends Error {}

const ReviewInput = Schema.Struct({
  id: Schema.optional(Schema.String),
  threadId: Schema.String,
  groupId: Schema.NullOr(Schema.String),
  text: Schema.String,
});

const NonNegativeSafeInteger = Schema.Number.check(
  Schema.makeFilter((value) => Number.isSafeInteger(value) && value >= 0),
);

const ReviewClaim = Schema.Struct({
  id: Schema.String,
  acquiredAtMs: NonNegativeSafeInteger,
  leaseExpiresAtMs: NonNegativeSafeInteger,
  throughPromptCount: NonNegativeSafeInteger,
  inputIds: Schema.Array(Schema.String),
}).check(Schema.makeFilter((claim) => claim.leaseExpiresAtMs >= claim.acquiredAtMs));

const ReviewCadence = Schema.Struct({
  acceptedPromptCount: NonNegativeSafeInteger,
  reviewedThroughPromptCount: NonNegativeSafeInteger,
  reviewInputs: Schema.optional(Schema.Array(ReviewInput)),
  settledTurnIds: Schema.optional(Schema.Array(Schema.String)),
  reviewClaim: Schema.optional(ReviewClaim),
}).check(
  Schema.makeFilter((value) => value.reviewedThroughPromptCount <= value.acceptedPromptCount),
);

const decodeReviewInput = Schema.decodeUnknownExit(ReviewInput);

const decodeReviewInputs = Schema.decodeUnknownExit(
  Schema.UndefinedOr(Schema.Array(Schema.Unknown)),
);

const decodeReviewCadence = Schema.decodeUnknownSync(Schema.fromJsonString(ReviewCadence));

function normalizeReviewInput(entry: typeof ReviewInput.Type): BotMemoryReviewInput {
  return {
    ...(entry.id ? { id: entry.id } : {}),
    threadId: entry.threadId,
    groupId: entry.groupId,
    text: entry.text,
  };
}

export const parseReviewInput = flow(decodeReviewInput, (result): BotMemoryReviewInput => {
  if (Exit.isFailure(result)) throw new InvalidReviewCadenceError("A review input is invalid.");

  return normalizeReviewInput(result.value);
});

export const parseReviewInputs = flow(
  decodeReviewInputs,
  (result): ReadonlyArray<BotMemoryReviewInput> => {
    if (Exit.isFailure(result)) throw new InvalidReviewCadenceError("Review inputs are invalid.");

    return result.value?.map((value) => parseReviewInput(value)) ?? [];
  },
);

export function parseReviewCadence(raw: string): BotMemoryReviewCadenceState {
  try {
    const value = decodeReviewCadence(raw);

    return {
      acceptedPromptCount: value.acceptedPromptCount,
      reviewedThroughPromptCount: value.reviewedThroughPromptCount,
      reviewInputs: value.reviewInputs?.map(normalizeReviewInput) ?? [],
      ...(value.settledTurnIds === undefined ? {} : { settledTurnIds: value.settledTurnIds }),
      ...(value.reviewClaim === undefined ? {} : { reviewClaim: value.reviewClaim }),
    };
  } catch {
    throw new InvalidReviewCadenceError("The bot memory review cadence file is invalid.");
  }
}
