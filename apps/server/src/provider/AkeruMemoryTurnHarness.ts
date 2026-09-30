import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import {
  type BotMemoryAccess,
  type BotMemoryReviewInput,
  type BotMemoryReviewReservation,
  type BotMemoryStore,
  formatBotMemoryPrompt,
} from "../memory/BotMemory.ts";
import { formatAutomaticBotMemoryReview } from "../memory/BotMemoryReview.ts";
import type { AkeruMemoryToolHandler } from "../memory/BotMemoryToolHandlers.ts";

export type AkeruMemoryReviewMode = "foreground" | "deferred";

export interface AkeruMemoryTurnAdmission {
  readonly access: BotMemoryAccess;
  readonly input: BotMemoryReviewInput;
  /**
   * When false the bot-private `MEMORY.md` is withheld from the supplied prompt
   * context, matching the "Private bot memory" setting. User and group memory
   * are unaffected.
   */
  readonly privateBotMemory?: boolean;
}

/**
 * Provider-neutral memory lifecycle for one admitted bot turn.
 *
 * Provider transports decide only where to deliver `context` and whether review execution is
 * foreground or deferred. Claim ownership, successful-prompt accounting, exact tool-call
 * verification, retries, and cleanup stay here.
 */
export class AkeruMemoryTurn {
  readonly context: string;
  readonly reviewIncluded: boolean;
  readonly access: BotMemoryAccess;

  private readonly store: BotMemoryStore;
  private readonly reservation: BotMemoryReviewReservation;
  get reviewCallContractSatisfied(): boolean {
    return this.successfulMemoryCalls === 1;
  }

  private successfulMemoryCalls = 0;
  private foregroundState: "pending" | "succeeded" | "failed" = "pending";
  private reviewSettled = false;
  private readonly semaphore = Effect.runPromise(Semaphore.make(1));
  private readonly scope: Scope.Scope;
  private scopeClosed = false;

  constructor(
    store: BotMemoryStore,
    access: BotMemoryAccess,
    reservation: BotMemoryReviewReservation,
    context: string,
    scope: Scope.Scope,
  ) {
    this.store = store;
    this.access = access;
    this.reservation = reservation;
    this.context = context;
    this.reviewIncluded = reservation.memoryReviewIncluded;
    this.scope = scope;
  }

  wrapMemoryHandler(handler: AkeruMemoryToolHandler): AkeruMemoryToolHandler {
    if (!this.reviewIncluded) return handler;
    return async (input) => {
      const result = await handler(input);
      this.successfulMemoryCalls += 1;
      return result;
    };
  }

  async freshReviewContext(): Promise<string> {
    const snapshot = formatBotMemoryPrompt(await this.store.readPromptSnapshot(this.access));
    return [snapshot, this.reviewInstruction()].filter(Boolean).join("\n\n");
  }

  async finishForeground(succeeded: boolean, mode: AkeruMemoryReviewMode): Promise<void> {
    return this.exclusive(async () => {
      if (this.foregroundState === "pending") {
        if (succeeded) {
          await this.store.recordSuccessfulPrompt(this.reservation);
          this.foregroundState = "succeeded";
        } else {
          this.foregroundState = "failed";
        }
      }
      if (this.foregroundState === "failed") {
        await this.settleReview(false);
        return;
      }
      if (!this.reviewIncluded) {
        await this.closeScope();
        return;
      }
      if (mode === "foreground") {
        await this.settleReview(this.reviewCallContractSatisfied);
      }
    });
  }

  async finishDeferredReview(succeeded: boolean): Promise<void> {
    return this.exclusive(async () => {
      await this.settleReview(
        this.foregroundState === "succeeded" && succeeded && this.reviewCallContractSatisfied,
      );
    });
  }

  async close(): Promise<void> {
    return this.abandon();
  }

  async abandon(): Promise<void> {
    return this.exclusive(async () => {
      if (this.foregroundState === "pending") this.foregroundState = "failed";
      await this.settleReview(false);
    });
  }

  private reviewInstruction(): string {
    return this.reviewIncluded
      ? formatAutomaticBotMemoryReview(this.access.groupId !== null, this.reservation.reviewInputs)
      : "";
  }

  private async settleReview(completed: boolean): Promise<void> {
    if (this.reviewSettled) return;
    if (this.reviewIncluded) await this.store.settleReviewClaim(this.reservation, completed);
    this.reviewSettled = true;
    await this.closeScope();
  }

  private async closeScope(): Promise<void> {
    if (this.scopeClosed) return;
    this.scopeClosed = true;
    await Effect.runPromise(Scope.close(this.scope, Exit.void));
  }

  async settleFromScope(): Promise<void> {
    if (this.reviewSettled) return;
    if (this.reviewIncluded) await this.store.settleReviewClaim(this.reservation, false);
    this.reviewSettled = true;
  }

  private exclusive(operation: () => Promise<void>): Promise<void> {
    return this.semaphore.then((semaphore) =>
      Effect.runPromise(Semaphore.withPermit(semaphore)(Effect.promise(operation))),
    );
  }
}

export class AkeruMemoryTurnHarness {
  private readonly store: BotMemoryStore;

  constructor(store: BotMemoryStore) {
    this.store = store;
  }

  async admit({
    access,
    input,
    privateBotMemory,
  }: AkeruMemoryTurnAdmission): Promise<AkeruMemoryTurn> {
    const reservation = await this.store.reserveReviewCadence(access.botId, input);
    const scope = await Effect.runPromise(Scope.make());
    try {
      const promptSnapshot = await this.store.readPromptSnapshot(access);
      const snapshot = formatBotMemoryPrompt(
        privateBotMemory === false
          ? { ...promptSnapshot, memory: { ...promptSnapshot.memory, content: "", charCount: 0 } }
          : promptSnapshot,
      );
      const review = reservation.memoryReviewIncluded
        ? formatAutomaticBotMemoryReview(access.groupId !== null, reservation.reviewInputs)
        : "";
      const turn = new AkeruMemoryTurn(
        this.store,
        access,
        reservation,
        [snapshot, review].filter(Boolean).join("\n\n"),
        scope,
      );
      const store = this.store;
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.acquireRelease(Effect.succeed(turn), () =>
            Effect.promise(() => turn.settleFromScope()),
          );
          if (turn.reviewIncluded) {
            yield* Effect.promise(() =>
              store.renewReviewClaim(reservation).catch(() => false),
            ).pipe(Effect.repeat(Schedule.fixed("20 seconds")), Effect.asVoid, Effect.forkScoped);
          }
        }).pipe(Effect.provideService(Scope.Scope, scope)),
      );
      return turn;
    } catch (cause) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await this.store.settleReviewCadence(reservation, false);
      throw cause;
    }
  }
}
