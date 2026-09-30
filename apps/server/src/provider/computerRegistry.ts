import {
  ComputerError,
  ComputerFrame,
  COMPUTER_FRAME_MAX_BYTES,
  type ComputerActionReceipt,
  type ComputerEvent,
  type ComputerInput,
  type ComputerSessionInput,
  type ComputerState,
  type ThreadId,
} from "@t3tools/contracts";
import type { WorkspaceComputer } from "./workspaceComputer.ts";
import { Effect, Queue, Schedule, Schema, Stream } from "effect";

const decodeFrame = Schema.decodeUnknownSync(ComputerFrame);
const isComputerError = Schema.is(ComputerError);

type Registration = { computer: WorkspaceComputer; controlUnavailableReason: string | null };

/** Transient observation/control boundary. Never writes teaching or orchestration records. */
export class ComputerRegistry {
  private readonly connections = new Map<string, Set<() => void>>();
  private readonly threads = new Map<string, Registration>();
  private readonly listeners = new Map<string, Set<(event: ComputerEvent) => void>>();
  private readonly actionListeners = new Set<(receipt: ComputerActionReceipt) => void>();
  private readonly ordinals = new WeakMap<WorkspaceComputer, number>();

  register(threadId: string, computer: WorkspaceComputer, controlUnavailableReason: string | null) {
    const registration = { computer, controlUnavailableReason };
    this.threads.set(threadId, registration);
    const unsubscribe = computer.gate.subscribe(() => this.publish(threadId));
    if (controlUnavailableReason) computer.gate.revokeControl();
    return () => {
      unsubscribe();
      if (this.threads.get(threadId) !== registration) return;
      this.threads.delete(threadId);
      if (![...this.threads.values()].some((value) => value.computer === computer))
        computer.gate.stop();
      this.publish(threadId);
    };
  }

  state(threadId: ThreadId): ComputerState {
    const entry = this.threads.get(threadId);
    if (!entry)
      return {
        threadId,
        status: "unavailable",
        capability: "none",
        controlAvailable: false,
        workspaceId: null,
        reason: "A graphical Daytona workspace on Codex or Kimi is required.",
      };
    const unsafe = [...this.threads.values()].find(
      (value) => value.computer === entry.computer && value.controlUnavailableReason,
    );
    return {
      threadId,
      status: entry.computer.gate.status,
      capability: "desktop",
      controlAvailable: !unsafe,
      workspaceId: entry.computer.workspaceId,
      reason: unsafe?.controlUnavailableReason ?? null,
    };
  }

  private computer(threadId: ThreadId) {
    const entry = this.threads.get(threadId);
    if (!entry)
      throw new ComputerError({
        code: "unsupported",
        message: "Computer is unavailable for this workspace.",
      });
    return entry.computer;
  }

  private publish(threadId: string) {
    for (const listener of this.listeners.get(threadId) ?? [])
      listener({ _tag: "state", state: this.state(threadId as ThreadId) });
  }

  private publishWorkspace(computer: WorkspaceComputer) {
    for (const [threadId, entry] of this.threads)
      if (entry.computer === computer) this.publish(threadId);
  }

  async open(threadId: ThreadId) {
    const computer = this.computer(threadId);
    await computer.open();
    this.publishWorkspace(computer);
    return this.state(threadId);
  }

  async acquire(threadId: ThreadId, clientId: string) {
    const state = this.state(threadId);
    if (!state.controlAvailable)
      throw new ComputerError({
        code: "unsupported",
        message: state.reason ?? "Exclusive computer control is unavailable.",
      });
    const computer = this.computer(threadId);
    const session = await computer.gate.acquire(clientId);
    this.publishWorkspace(computer);
    return { ...session, state: this.state(threadId) };
  }

  /** Runs synchronously under the input gate after success. Metadata only; richer capture is unsupported. */
  subscribeActions(listener: (receipt: ComputerActionReceipt) => void) {
    this.actionListeners.add(listener);
    return () => {
      this.actionListeners.delete(listener);
    };
  }

  async input(input: ComputerInput, clientId: string) {
    const computer = this.computer(input.threadId);
    if (!this.state(input.threadId).controlAvailable)
      throw new ComputerError({
        code: "unsupported",
        message: "Exclusive computer control is unavailable.",
      });
    await computer.gate.input(clientId, input.sessionId, input.sequence, async () => {
      const generation = computer.gate.generation;
      await computer.input(input.action);
      if (generation !== computer.gate.generation) return;
      const ordinal = (this.ordinals.get(computer) ?? 0) + 1;
      this.ordinals.set(computer, ordinal);
      const receipt = { workspaceId: computer.workspaceId, ordinal, category: input.action._tag };
      for (const listener of this.actionListeners) {
        try {
          listener(receipt);
        } catch {
          this.actionListeners.delete(listener);
        }
      }
      for (const [threadId, entry] of this.threads) {
        if (entry.computer !== computer) continue;
        for (const listener of this.listeners.get(threadId) ?? [])
          listener({ _tag: "action", receipt });
      }
    });
  }

  async release(input: ComputerSessionInput, clientId: string) {
    const computer = this.computer(input.threadId);
    await computer.gate.release(clientId, input.sessionId);
    this.publishWorkspace(computer);
    return this.state(input.threadId);
  }

  async close(threadId: ThreadId, clientId: string) {
    const computer = this.computer(threadId);
    await computer.gate.releaseClient(clientId);
    this.publishWorkspace(computer);
    return this.state(threadId);
  }

  stop(threadId: ThreadId) {
    const computer = this.computer(threadId);
    computer.gate.stop();
    this.publishWorkspace(computer);
    return this.state(threadId);
  }

  disconnect(clientId: string) {
    for (const close of this.connections.get(clientId) ?? []) close();
    for (const [threadId, { computer }] of this.threads) {
      computer.gate.disconnect(clientId);
      this.publish(threadId);
    }
  }

  events(threadId: ThreadId, clientId: string): Stream.Stream<ComputerEvent, ComputerError> {
    const registry = this;
    return Stream.callback<ComputerEvent, ComputerError>(
      (queue) =>
        Effect.gen(function* () {
          const entry = registry.threads.get(threadId);
          if (!entry) {
            return yield* new ComputerError({
              code: "unsupported",
              message: "Computer observation is unavailable.",
            });
          }
          const computer = entry.computer;
          let active = true;
          const close = () => {
            active = false;
            Queue.endUnsafe(queue);
          };
          const listener = (event: ComputerEvent) => {
            if (!active) return;
            Queue.offerUnsafe(queue, event);
            if (
              event._tag === "state" &&
              (event.state.status === "stopped" || event.state.status === "unavailable")
            )
              close();
          };
          let connections = registry.connections.get(clientId);
          if (!connections) registry.connections.set(clientId, (connections = new Set()));
          connections.add(close);
          let listeners = registry.listeners.get(threadId);
          if (!listeners) registry.listeners.set(threadId, (listeners = new Set()));
          listeners.add(listener);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              active = false;
              connections.delete(close);
              if (connections.size === 0) registry.connections.delete(clientId);
              listeners.delete(listener);
              if (listeners.size === 0) registry.listeners.delete(threadId);
            }),
          );
          listener({ _tag: "state", state: registry.state(threadId) });
          const capture = Effect.tryPromise({
            try: async () => {
              if (!active || registry.threads.get(threadId) !== entry) return;
              const state = registry.state(threadId);
              listener({ _tag: "state", state });
              if (state.status !== "ready" && state.status !== "human") return;
              const generation = computer.gate.generation;
              const frame = decodeFrame(await computer.capture());
              if (Buffer.byteLength(frame.data, "base64") > COMPUTER_FRAME_MAX_BYTES) {
                throw new ComputerError({
                  code: "adapter",
                  message: "Computer frame exceeds transport budget.",
                });
              }
              if (
                active &&
                registry.threads.get(threadId) === entry &&
                computer.gate.generation === generation
              ) {
                listener({ _tag: "frame", frame });
              }
            },
            catch: (cause) =>
              isComputerError(cause)
                ? cause
                : new ComputerError({ code: "adapter", message: "Computer frame is unavailable." }),
          }).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                // Taking or returning control invalidates an in-flight frame;
                // that stale frame is dropped, not a reason to stop the computer.
                if (error.code === "revoked") return;
                if (registry.threads.get(threadId) === entry) {
                  computer.gate.stop();
                  registry.publishWorkspace(computer);
                }
              }),
            ),
          );
          yield* capture.pipe(Effect.repeat(Schedule.spaced("2 seconds")), Effect.forkScoped);
        }),
      { bufferSize: 1, strategy: "sliding" },
    );
  }
}

export const computerRegistry = new ComputerRegistry();
