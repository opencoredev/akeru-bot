import { cn } from "../../lib/utils";
import { BotAvatarView } from "./BotAvatarView";
import { groupBotMembers } from "./roster.logic";
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
  const groupBots = groupBotMembers(group, bots)
    .filter((bot) => bot.archivedAt === null)
    .sort((a, b) => {
      if (a.id === group.bossBotId) return -1;
      if (b.id === group.bossBotId) return 1;
      return 0;
    });
  return (
    <div className={cn("inline-flex -space-x-1.5", className)}>
      {groupBots.slice(0, 2).map((bot) => (
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
