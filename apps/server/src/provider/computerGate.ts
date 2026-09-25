// @effect-diagnostics nodeBuiltinImport:off
import { Clock, Duration, Effect, Fiber } from "effect";
import * as NodeCrypto from "node:crypto";
import { ComputerError, COMPUTER_SESSION_TTL_MS } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** One gate per native workspace. Raw MCP attachments must not coexist with this gate. */
export class ComputerGate {
  private tail: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  private stopped = false;
  private owner:
    | { clientId: string; sessionId: string; expiresAt: number; sequence: number; revoked: Promise<void> }
    | undefined;
  private readonly clock: Clock.Clock;
  private readonly listeners = new Set<() => void>();
  private cancelExpiry: (() => void) | undefined;
  private revokeInput: (() => void) | undefined;
  constructor(clock: Clock.Clock = Effect.runSync(Clock.Clock)) { this.clock = clock; }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private fail(code: ComputerError["code"]): never {
    throw new ComputerError({ code, message: `Computer operation rejected: ${code}.` });
  }

  get status(): "stopped" | "human" | "ready" {
    this.checkExpiry();
    return this.stopped ? "stopped" : this.owner ? "human" : "ready";
  }

  private checkExpiry() {
    if (this.owner && this.clock.currentTimeMillisUnsafe() >= this.owner.expiresAt) this.stop();
  }

  private scheduleOwnerExpiry(owner: { readonly expiresAt: number }) {
    this.cancelExpiry?.();
    const fiber = Effect.runFork(this.clock.sleep(Duration.millis(
      Math.max(0, owner.expiresAt - this.clock.currentTimeMillisUnsafe()),
    )).pipe(Effect.andThen(Effect.sync(() => {
      this.cancelExpiry = undefined;
      if (this.owner === owner) this.stop();
    }))));
    this.cancelExpiry = () => { Effect.runFork(Fiber.interrupt(fiber)); };
  }

  private ordered<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  bot<T>(operation: () => Promise<T>): Promise<T> {
    this.checkExpiry();
    if (this.stopped)
      return Promise.reject(new ComputerError({ code: "closed", message: "Computer is stopped." }));
    if (this.owner)
      return Promise.reject(
        new ComputerError({ code: "busy", message: "Human control is active." }),
      );
    const epoch = this.epoch;
    return this.ordered(async () => {
      this.checkExpiry();
      if (this.stopped || epoch !== this.epoch || this.owner) this.fail("revoked");
      return operation();
    });
  }

  async acquire(clientId: string) {
    this.checkExpiry();
    if (this.stopped) this.fail("closed");
    if (this.owner) this.fail("busy");
    const revoked = new Promise<void>((resolve) => { this.revokeInput = resolve; });
    const owner = {
      revoked,
      clientId,
      sessionId: NodeCrypto.randomUUID(),
      expiresAt: this.clock.currentTimeMillisUnsafe() + COMPUTER_SESSION_TTL_MS,
      sequence: 0,
    };
    this.owner = owner;
    this.scheduleOwnerExpiry(owner);
    this.epoch++;
    await this.tail;
    this.checkExpiry();
    if (this.owner !== owner || this.stopped) this.fail("revoked");
    return { sessionId: owner.sessionId, expiresAt: owner.expiresAt };
  }

  input<T>(clientId: string, sessionId: string, sequence: number, operation: () => Promise<T>) {
    this.checkExpiry();
    const owner = this.owner;
    if (this.stopped || !owner || owner.clientId !== clientId || owner.sessionId !== sessionId)
      this.fail("revoked");
    if (!Number.isSafeInteger(sequence) || sequence !== owner.sequence + 1) this.fail("sequence");
    owner.sequence = sequence;
    // Keep the physical operation in the queue even when its caller is revoked.
    const operationResult = this.ordered(async () => {
      this.checkExpiry();
      if (this.stopped || this.owner !== owner) this.fail("revoked");
      try {
        const result = await operation();
        this.checkExpiry();
        if (this.stopped || this.owner !== owner) this.fail("revoked");
        return result;
      } catch (cause) {
        if (Schema.is(ComputerError)(cause)) throw cause;
        this.revokeInput = undefined;
        this.stop();
        return this.fail("adapter");
      }
    });
    return Promise.race([operationResult, owner.revoked.then(() => this.fail("revoked"))]);
  }

  async release(clientId: string, sessionId: string) {
    this.checkExpiry();
    if (!this.owner || this.owner.clientId !== clientId || this.owner.sessionId !== sessionId)
      this.fail("revoked");
    this.owner = undefined;
    this.cancelExpiry?.();
    this.cancelExpiry = undefined;

    this.epoch++;
    await this.tail;
  }

  async releaseClient(clientId: string) {
    if (this.owner?.clientId === clientId) await this.release(clientId, this.owner.sessionId);
  }

  revokeControl() {
    if (this.owner) this.stop();
  }

  disconnect(clientId: string) {
    if (this.owner?.clientId === clientId) this.stop();
  }

  stop() {
    this.stopped = true;
    this.revokeInput?.();
    this.revokeInput = undefined;
    this.cancelExpiry?.();
    this.cancelExpiry = undefined;
    this.owner = undefined;

    this.epoch++;
    for (const listener of this.listeners) listener();
  }

  get generation() {
    return this.epoch;
  }

  async open() {
    if (!this.stopped) return;
    const epoch = this.epoch;
    await this.tail;
    if (epoch !== this.epoch) this.fail("revoked");
    this.stopped = false;
  }
}
