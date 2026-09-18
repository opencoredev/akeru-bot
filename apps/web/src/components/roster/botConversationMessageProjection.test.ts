import { MessageId, TurnId, type OrchestrationMessage } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  createBotConversationMessageProjectionAtom,
  type BotConversationMessageProjection,
} from "./botConversationMessageProjection";

const message = (
  id: string,
  role: "user" | "assistant" | "system",
  streaming: boolean,
  turnId: string | null = null,
): OrchestrationMessage =>
  ({
    id: MessageId.make(id),
    role,
    text: id,
    turnId: turnId === null ? null : TurnId.make(turnId),
    streaming,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
  }) as const;

describe("bot conversation message projection atom", () => {
  it("does not publish hidden streaming deltas but publishes completion and visible edits", () => {
    const user = message("user", "user", false);
    const streaming = message("reply", "assistant", true, "turn-1");
    const source = Atom.make<ReadonlyArray<OrchestrationMessage>>([user, streaming]);
    const projection = createBotConversationMessageProjectionAtom(source);
    const registry = AtomRegistry.make();
    const observed: BotConversationMessageProjection[] = [];
    const unsubscribe = registry.subscribe(projection, (value) => observed.push(value), {
      immediate: true,
    });

    try {
      const initial = observed[0]!;
      expect(initial.messages).toEqual([user]);
      expect(initial.lastMessageRole).toBe("assistant");

      registry.set(source, [user, { ...streaming, text: "reply delta" }]);
      expect(observed).toHaveLength(1);

      const editedUser = { ...user, text: "edited user message" };
      registry.set(source, [editedUser, { ...streaming, text: "another hidden delta" }]);
      expect(observed).toHaveLength(2);
      expect(observed[1]!.messages[0]).toBe(editedUser);

      registry.set(source, [editedUser, { ...streaming, text: "one more hidden delta" }]);
      expect(observed).toHaveLength(2);

      const completed = { ...streaming, streaming: false, text: "final answer" };
      registry.set(source, [editedUser, completed]);
      expect(observed).toHaveLength(3);
      expect(observed[2]!.messages).toEqual([editedUser, completed]);

      const edited = { ...completed, reactions: [] };
      registry.set(source, [editedUser, edited]);
      expect(observed).toHaveLength(4);
      expect(observed[3]!.messages[1]).toBe(edited);
    } finally {
      unsubscribe();
      registry.dispose();
    }
  });

  it("publishes last-message role changes needed by resume controls", () => {
    const user = message("user", "user", false);
    const source = Atom.make<ReadonlyArray<OrchestrationMessage>>([user]);
    const projection = createBotConversationMessageProjectionAtom(source);
    const registry = AtomRegistry.make();
    const observed: string[] = [];
    const unsubscribe = registry.subscribe(
      projection,
      (value) => observed.push(value.lastMessageRole ?? "none"),
      { immediate: true },
    );

    try {
      registry.set(source, [user, message("status", "system", false)]);
      expect(observed).toEqual(["user", "system"]);
    } finally {
      unsubscribe();
      registry.dispose();
    }
  });
});
