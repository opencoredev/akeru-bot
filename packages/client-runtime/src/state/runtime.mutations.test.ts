import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

describe("Atom.fn mutation semantics", () => {
  it.effect("interrupts the previous invocation when the same mutation atom is written again", () =>
    Effect.gen(function* () {
      const firstLatch = Latch.makeUnsafe();
      const secondLatch = Latch.makeUnsafe();
      const interrupted: string[] = [];

      const mutation = Atom.fn((id: "first" | "second") =>
        (id === "first" ? firstLatch : secondLatch).await.pipe(
          Effect.as(id),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted.push(id);
            }),
          ),
        ),
      );

      const registry = AtomRegistry.make();
      const unmount = registry.mount(mutation);

      registry.set(mutation, "first");
      registry.set(mutation, "second");
      yield* Effect.yieldNow;

      expect(interrupted).toEqual(["first"]);

      secondLatch.openUnsafe();
      expect(
        yield* AtomRegistry.getResult(registry, mutation, {
          suspendOnWaiting: true,
        }),
      ).toBe("second");

      unmount();
      registry.dispose();
    }),
  );

  it.effect("keeps stream mutations waiting until the final emitted value", () =>
    Effect.gen(function* () {
      const completionLatch = Latch.makeUnsafe();

      const mutation = Atom.fn(() =>
        Stream.make("progress").pipe(
          Stream.concat(Stream.fromEffect(completionLatch.await.pipe(Effect.as("done")))),
        ),
      );

      const registry = AtomRegistry.make();
      const unmount = registry.mount(mutation);

      registry.set(mutation, undefined);

      const progress = registry.get(mutation);
      expect(AsyncResult.isSuccess(progress)).toBe(true);

      if (AsyncResult.isSuccess(progress)) {
        expect(progress.value).toBe("progress");
        expect(progress.waiting).toBe(true);
      }

      completionLatch.openUnsafe();
      expect(
        yield* AtomRegistry.getResult(registry, mutation, {
          suspendOnWaiting: true,
        }),
      ).toBe("done");

      unmount();
      registry.dispose();
    }),
  );
});
