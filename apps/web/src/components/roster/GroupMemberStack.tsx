import { cn } from "../../lib/utils";
import { BotAvatarView } from "./BotAvatarView";
import { groupBotMembers } from "./roster.logic";
import type { Bot, Group } from "./types";

export function GroupMemberStack({
  group,
  bots,
  sizeClassName = "size-6",
  className,
}: {
  readonly group: Group;
  readonly bots: ReadonlyArray<Bot>;
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
    <div className={cn("relative inline-flex shrink-0", sizeClassName, className)}>
      {groupBots.slice(0, 2).map((bot, index) => (
        <BotAvatarView
          key={bot.id}
          avatar={bot.avatar}
          name={bot.name}
          className={cn(
            "absolute size-[68%]",
            index === 0 ? "left-0 top-0" : "bottom-0 right-0 z-10",
          )}
        />
      ))}
    </div>
  );
}
