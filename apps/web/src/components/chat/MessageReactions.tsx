import type { OrchestrationMessageReaction } from "@t3tools/contracts";

export function MessageReactions({
  reactions,
}: {
  readonly reactions: ReadonlyArray<OrchestrationMessageReaction>;
}) {
  const counts = new Map<string, number>();
  for (const reaction of reactions) {
    counts.set(reaction.emoji, (counts.get(reaction.emoji) ?? 0) + 1);
  }
  if (counts.size === 0) return null;

  return (
    <div className="mt-1 flex flex-wrap gap-1" data-testid="message-reactions">
      {[...counts].map(([emoji, count]) => (
        <span
          key={emoji}
          className="rounded-full border border-border bg-background px-2 py-0.5 text-xs"
          data-reaction-emoji={emoji}
        >
          {emoji}
          {count > 1 ? ` ${count}` : ""}
        </span>
      ))}
    </div>
  );
}
