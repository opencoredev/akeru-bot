import type {
  AkeruMemoryCandidate,
  AkeruMemoryCandidateId,
  AkeruMemoryDecisionReceipt,
  AkeruMemoryRevision,
  AkeruMemoryThreadAccess,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { AkeruMemoryAccessDenied } from "../EntityMemoryAccess.ts";

export class MemoryCandidateConflictError extends Schema.TaggedErrorClass<MemoryCandidateConflictError>()(
  "MemoryCandidateConflictError",
  { candidateId: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Memory candidate ${this.candidateId}: ${this.detail}`;
  }
}

export interface CreateMemoryCandidateInput {
  readonly access: AkeruMemoryThreadAccess;
  readonly candidate: AkeruMemoryCandidate;
}

export interface ListMemoryCandidatesInput {
  readonly access: AkeruMemoryThreadAccess;
}

export interface ApproveMemoryCandidateInput {
  readonly access: AkeruMemoryThreadAccess;
  readonly candidateId: AkeruMemoryCandidateId;
  readonly revision: AkeruMemoryRevision;
  readonly receiptId: string;
  readonly decidedAt: string;
}

export interface RejectMemoryCandidateInput {
  readonly access: AkeruMemoryThreadAccess;
  readonly candidateId: AkeruMemoryCandidateId;
  readonly receiptId: string;
  readonly decidedAt: string;
}

export type MemoryCandidateRepositoryError =
  | ProjectionRepositoryError
  | AkeruMemoryAccessDenied
  | MemoryCandidateConflictError;

export interface MemoryCandidateRepositoryShape {
  readonly create: (
    input: CreateMemoryCandidateInput,
  ) => Effect.Effect<AkeruMemoryCandidate, MemoryCandidateRepositoryError>;
  readonly listPending: (
    input: ListMemoryCandidatesInput,
  ) => Effect.Effect<ReadonlyArray<AkeruMemoryCandidate>, MemoryCandidateRepositoryError>;
  readonly approve: (
    input: ApproveMemoryCandidateInput,
  ) => Effect.Effect<AkeruMemoryDecisionReceipt, MemoryCandidateRepositoryError>;
  readonly reject: (
    input: RejectMemoryCandidateInput,
  ) => Effect.Effect<AkeruMemoryDecisionReceipt, MemoryCandidateRepositoryError>;
}

export class MemoryCandidateRepository extends Context.Service<
  MemoryCandidateRepository,
  MemoryCandidateRepositoryShape
>()("akeru-bot/memory/Services/MemoryCandidateRepository") {}
