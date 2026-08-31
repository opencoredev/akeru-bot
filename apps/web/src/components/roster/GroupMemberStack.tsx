import { cn } from "../../lib/utils";
import { BotAvatarView } from "./BotAvatarView";
import { groupBotMembers, groupPersonMembers } from "./roster.logic";
import type { Bot, Group } from "./types";

export function GroupMemberStack({
  group,
  bots,
  ringClassName,
  sizeClassName = "size-6",
  className,
}: {
  readonly group: Group;
  readonly bots: ReadonlyArray<Bot>;
  readonly ringClassName: string;
  readonly sizeClassName?: string;
  readonly className?: string;
}) {
  const people = groupPersonMembers(group);
  const groupBots = groupBotMembers(group, bots);
  return (
    <div className={cn("flex -space-x-1.5", className)}>
      {people.slice(0, 2).map((person) => (
        <span
          key={person.personId}
          aria-label={person.displayName}
          className={cn(
            "flex items-center justify-center rounded-full bg-muted text-[10px] font-semibold ring-2",
            sizeClassName,
            ringClassName,
          )}
        >
          {person.displayName.slice(0, 1).toUpperCase()}
        </span>
      ))}
      {groupBots.slice(0, Math.max(1, 3 - people.length)).map((bot) => (
        <BotAvatarView
          key={bot.id}
          avatar={bot.avatar}
          name={bot.name}
          className={cn("ring-2", sizeClassName, ringClassName)}
        />
      ))}
    </div>
  );
}
