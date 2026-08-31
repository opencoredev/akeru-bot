import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

export class MemoryRevisionWriteLock extends Context.Service<
  MemoryRevisionWriteLock,
  Semaphore.Semaphore
>()("akeru-bot/memory/Services/MemoryRevisionWriteLock") {}

export const MemoryRevisionWriteLockLive = Layer.effect(MemoryRevisionWriteLock, Semaphore.make(1));
