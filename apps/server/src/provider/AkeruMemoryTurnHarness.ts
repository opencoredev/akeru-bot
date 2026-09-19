// @effect-diagnostics globalTimers:off
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
  private operation: Promise<void> = Promise.resolve();
  private readonly heartbeat: NodeJS.Timeout | undefined;

  constructor(
    store: BotMemoryStore,
    access: BotMemoryAccess,
    reservation: BotMemoryReviewReservation,
    context: string,
  ) {
    this.store = store;
    this.access = access;
    this.reservation = reservation;
    this.context = context;
    this.reviewIncluded = reservation.memoryReviewIncluded;
    this.heartbeat = this.reviewIncluded
      ? setInterval(() => {
          void this.store.renewReviewClaim(this.reservation).catch(() => undefined);
        }, 20_000)
      : undefined;
    this.heartbeat?.unref();
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
        this.stopHeartbeat();
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
    this.stopHeartbeat();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
  }

  private exclusive(operation: () => Promise<void>): Promise<void> {
    const next = this.operation.then(operation, operation);
    this.operation = next.catch(() => undefined);
    return next;
  }
}

export class AkeruMemoryTurnHarness {
  private readonly store: BotMemoryStore;

  constructor(store: BotMemoryStore) {
    this.store = store;
  }

  async admit({ access, input }: AkeruMemoryTurnAdmission): Promise<AkeruMemoryTurn> {
    const reservation = await this.store.reserveReviewCadence(access.botId, input);
    try {
      const snapshot = formatBotMemoryPrompt(await this.store.readPromptSnapshot(access));
      const review = reservation.memoryReviewIncluded
        ? formatAutomaticBotMemoryReview(access.groupId !== null, reservation.reviewInputs)
        : "";
      return new AkeruMemoryTurn(
        this.store,
        access,
        reservation,
        [snapshot, review].filter(Boolean).join("\n\n"),
      );
    } catch (cause) {
      await this.store.settleReviewCadence(reservation, false);
      throw cause;
    }
  }
}
