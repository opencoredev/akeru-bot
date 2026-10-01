
import { NodeFS, directories, fixture, acceptPrompt } from "./testUtils/botMemory.ts";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { BotId } from "@akeru/contracts";
import {
  AKERU_MEMORY_REVIEW_BATCH_MAX_CHARS,
  AKERU_MEMORY_REVIEW_INPUT_MAX_CHARS,
  BotMemoryStore,
} from "./BotMemory.ts";

describe("BotMemoryStore", () => {
  it("persists the ten-prompt review cadence across store restarts", async () => {
    const store = await fixture();
    const botId = BotId.make("bot-review-cadence");

    for (let prompt = 1; prompt <= 10; prompt += 1) {
      const cadence = await acceptPrompt(store, botId, false);
      assert.equal(cadence.acceptedPromptCount, prompt);
      assert.equal(cadence.dueOnNextAcceptedPrompt, prompt === 10);
    }

    const restarted = new BotMemoryStore(NodePath.dirname(store.memoryRoot));
    assert.deepEqual(await restarted.readReviewCadence(botId), {
      acceptedPromptCount: 10,
      reviewedThroughPromptCount: 0,
      dueOnNextAcceptedPrompt: true,
    });

    const reviewed = await acceptPrompt(restarted, botId, true);
    assert.deepEqual(reviewed, {
      acceptedPromptCount: 11,
      reviewedThroughPromptCount: 10,
      dueOnNextAcceptedPrompt: false,
    });
    assert.equal(
      (await NodeFS.stat(NodePath.join(store.memoryRoot, "bots", botId, ".memory-review.json")))
        .mode & 0o777,
      0o600,
    );
  });

  it("keeps review cadence isolated per bot and changes it only for accepted prompts", async () => {
    const store = await fixture();
    const first = BotId.make("bot-review-one");
    const second = BotId.make("bot-review-two");

    await acceptPrompt(store, first, false);
    await acceptPrompt(store, first, false);

    assert.equal((await store.readReviewCadence(first)).acceptedPromptCount, 2);
    assert.deepEqual(await store.readReviewCadence(second), {
      acceptedPromptCount: 0,
      reviewedThroughPromptCount: 0,
      dueOnNextAcceptedPrompt: false,
    });
  });

  it("claims a due review atomically across store instances", async () => {
    const firstStore = await fixture();
    const secondStore = new BotMemoryStore(NodePath.dirname(firstStore.memoryRoot));
    const botId = BotId.make("bot-two-store-cadence");

    for (let prompt = 1; prompt <= 10; prompt += 1) {
      await acceptPrompt(firstStore, botId, false);
    }

    const reservations = await Promise.all([
      firstStore.reserveReviewCadence(botId),
      secondStore.reserveReviewCadence(botId),
    ]);

    assert.equal(reservations.filter((entry) => entry.memoryReviewIncluded).length, 1);
  });

  it("settles a reservation idempotently", async () => {
    const store = await fixture();
    const botId = BotId.make("bot-idempotent-cadence");
    const reservation = await store.reserveReviewCadence(botId);
    await store.settleReviewCadence(reservation, true);
    await store.settleReviewCadence(reservation, true);
    assert.equal((await store.readReviewCadence(botId)).acceptedPromptCount, 1);

    const next = await store.reserveReviewCadence(botId);
    await store.settleReviewCadence(next, false);
    await store.settleReviewCadence(next, false);
    assert.equal((await store.readReviewCadence(botId)).acceptedPromptCount, 1);
  });

  it("keeps private and exact-group cadence and candidates independent", async () => {
    const store = await fixture();
    const botId = BotId.make("bot-cross-thread-review-inputs");

    for (let prompt = 1; prompt <= 10; prompt += 1) {
      const reservation = await store.reserveReviewCadence(botId, {
        threadId: `thread-${prompt % 2}`,
        groupId: null,
        text: prompt === 1 ? "I really like cats." : `Filler prompt ${prompt}`,
      });

      await store.settleReviewCadence(reservation, true);
    }

    const privateReview = await store.reserveReviewCadence(botId, {
      threadId: "thread-3",
      groupId: null,
      text: "Next private prompt",
    });

    const groupReview = await store.reserveReviewCadence(botId, {
      threadId: "group-thread",
      groupId: "group-a",
      text: "First group prompt",
    });

    assert.isTrue(privateReview.memoryReviewIncluded);
    assert.include(JSON.stringify(privateReview.reviewInputs), "I really like cats.");
    assert.isFalse(groupReview.memoryReviewIncluded);
    assert.notInclude(JSON.stringify(groupReview.reviewInputs), "cats");
    assert.equal((await store.readReviewCadence(botId, "group-a")).acceptedPromptCount, 0);
    await store.settleReviewCadence(privateReview, true);

    const persisted = await NodeFS.readFile(
      NodePath.join(store.memoryRoot, "bots", botId, ".memory-review.json"),
      "utf8",
    );

    assert.include(persisted, "Next private prompt");
    assert.notInclude(persisted, "I really like cats.");
  });

  it("does not record an undispatched reservation and records terminal success once", async () => {
    const stateDir = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "akeru-memory-crash-"));
    directories.push(stateDir);
    const botId = BotId.make("bot-crashed-threshold-candidate");
    const crashed = new BotMemoryStore(stateDir);

    const abandoned = await crashed.reserveReviewCadence(botId, {
      threadId: "thread-before-crash",
      groupId: null,
      text: "My tenth prompt says I foster kittens.",
    });

    assert.isFalse(abandoned.memoryReviewIncluded);

    const restarted = new BotMemoryStore(stateDir);
    assert.equal((await restarted.readReviewCadence(botId)).acceptedPromptCount, 0);
    await restarted.recordSuccessfulPrompt(abandoned);
    await restarted.recordSuccessfulPrompt(abandoned);
    assert.equal((await restarted.readReviewCadence(botId)).acceptedPromptCount, 1);
  });

  it("recovers a stale persisted reservation conservatively", async () => {
    const store = await fixture();
    const botId = BotId.make("bot-stale-cadence-reservation");
    const cadencePath = NodePath.join(store.memoryRoot, "bots", botId, ".memory-review.json");
    await NodeFS.mkdir(NodePath.dirname(cadencePath), { recursive: true });
    await NodeFS.writeFile(
      cadencePath,
      JSON.stringify({
        acceptedPromptCount: 2,
        reviewedThroughPromptCount: 0,
        reviewClaim: {
          id: 42,
          acquiredAtMs: "invalid",
        },
      }),
      { mode: 0o600 },
    );

    const reservation = await store.reserveReviewCadence(botId);
    assert.isTrue(reservation.memoryReviewIncluded);
    await store.settleReviewCadence(reservation, true);
    assert.deepEqual(await store.readReviewCadence(botId), {
      acceptedPromptCount: 11,
      reviewedThroughPromptCount: 10,
      dueOnNextAcceptedPrompt: false,
    });
  });

  it("keeps a live review claim exclusive while foreground admission remains immediate", async () => {
    const stateDir = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "akeru-memory-live-"));
    directories.push(stateDir);
    const firstStore = new BotMemoryStore(stateDir);
    const secondStore = new BotMemoryStore(stateDir);
    const botId = BotId.make("bot-live-long-reservation");

    for (let prompt = 1; prompt <= 10; prompt += 1) await acceptPrompt(firstStore, botId, false);
    const active = await firstStore.reserveReviewCadence(botId);
    const cadencePath = NodePath.join(firstStore.memoryRoot, "bots", botId, ".memory-review.json");

    const activeState = JSON.parse(await NodeFS.readFile(cadencePath, "utf8")) as {
      reviewClaim: { acquiredAtMs: number };
    };

    activeState.reviewClaim.acquiredAtMs = 0;
    await NodeFS.writeFile(cadencePath, `${JSON.stringify(activeState)}\n`, { mode: 0o600 });
    const second = await secondStore.reserveReviewCadence(botId);
    assert.isTrue(active.memoryReviewIncluded);
    assert.isFalse(second.memoryReviewIncluded);
  });

  it("recovers a stale review claim after a maintenance crash", async () => {
    const store = await fixture();
    const botId = BotId.make("bot-stale-review-claim");

    for (let prompt = 1; prompt <= 10; prompt += 1) {
      const reservation = await store.reserveReviewCadence(botId, {
        threadId: `thread-${prompt}`,
        groupId: null,
        text: `Candidate ${prompt}`,
      });

      await store.recordSuccessfulPrompt(reservation);
    }

    const first = await store.reserveReviewCadence(botId);
    assert.isTrue(first.memoryReviewIncluded);
    const cadencePath = NodePath.join(store.memoryRoot, "bots", botId, ".memory-review.json");

    const state = JSON.parse(await NodeFS.readFile(cadencePath, "utf8")) as {
      reviewClaim: { acquiredAtMs: number; leaseExpiresAtMs: number };
    };

    state.reviewClaim.acquiredAtMs = 0;
    state.reviewClaim.leaseExpiresAtMs = 0;
    await NodeFS.writeFile(cadencePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    const recovered = await store.reserveReviewCadence(botId);
    assert.isTrue(recovered.memoryReviewIncluded);
    assert.lengthOf(recovered.reviewInputs, 10);
  });

  it("bounds candidates and the persisted review batch after repeated failed reviews", async () => {
    const store = await fixture();
    const botId = BotId.make("bot-bounded-review");

    for (let prompt = 1; prompt <= 30; prompt += 1) {
      const reservation = await store.reserveReviewCadence(botId, {
        threadId: `thread-${prompt}`,
        groupId: null,
        text: `${prompt}:${"x".repeat(AKERU_MEMORY_REVIEW_INPUT_MAX_CHARS * 2)}`,
      });

      await store.recordSuccessfulPrompt(reservation);

      if (reservation.memoryReviewIncluded) await store.settleReviewClaim(reservation, false);
    }

    const cadencePath = NodePath.join(store.memoryRoot, "bots", botId, ".memory-review.json");
    const raw = await NodeFS.readFile(cadencePath, "utf8");

    const persisted = JSON.parse(raw) as {
      readonly reviewInputs: ReadonlyArray<{ readonly text: string }>;
    };

    assert.isAtMost(persisted.reviewInputs.length, 10);
    assert.isTrue(
      persisted.reviewInputs.every(
        (input) => input.text.length <= AKERU_MEMORY_REVIEW_INPUT_MAX_CHARS,
      ),
    );
    assert.isAtMost(
      JSON.stringify(persisted.reviewInputs).length,
      AKERU_MEMORY_REVIEW_BATCH_MAX_CHARS,
    );
  });

  it.each([
    ["malformed JSON", "{"],
    ["invalid counters", '{"acceptedPromptCount":1,"reviewedThroughPromptCount":2}'],
    ["truncated state", '{"acceptedPromptCount":'],
  ])("quarantines %s and makes the next prompt a review", async (_label, invalid) => {
    const store = await fixture();
    const botId = BotId.make(`bot-corrupt-${directories.length}`);
    const reservation = await store.reserveReviewCadence(botId);
    await store.settleReviewCadence(reservation, false);
    const cadencePath = NodePath.join(store.memoryRoot, "bots", botId, ".memory-review.json");
    await NodeFS.writeFile(cadencePath, invalid, { mode: 0o600 });

    const restarted = new BotMemoryStore(NodePath.dirname(store.memoryRoot));
    const cadence = await restarted.readReviewCadence(botId);
    assert.isTrue(cadence.dueOnNextAcceptedPrompt);
    const files = await NodeFS.readdir(NodePath.dirname(cadencePath));
    const quarantine = files.find((file) => file.startsWith(".memory-review.corrupt-"));
    assert.isDefined(quarantine);
    assert.equal((await NodeFS.stat(cadencePath)).mode & 0o777, 0o600);
    assert.equal(
      (await NodeFS.stat(NodePath.join(NodePath.dirname(cadencePath), quarantine))).mode & 0o777,
      0o600,
    );
  });
});
