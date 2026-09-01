import { CircleAlertIcon } from "lucide-react";

import type { BotInboxItem } from "../../botInbox";
import { Button } from "../ui/button";
import { ComposerBannerStack } from "../chat/ComposerBannerStack";

export function BotInboxAlertStack({
  items,
  onOpenDetails,
}: {
  readonly items: ReadonlyArray<BotInboxItem>;
  readonly onOpenDetails: () => void;
}) {
  const visibleItems = items.filter(
    (item) => item.kind !== "approval-request" && item.kind !== "routine-failure",
  );
  if (visibleItems.length === 0) return null;

  return (
    <ComposerBannerStack
      className="relative z-0 mx-4 sm:mx-6"
      items={visibleItems.map((item) => ({
        id: item.id,
        variant: "error",
        icon: <CircleAlertIcon />,
        title: `${item.botName} · ${item.taskOrRoutine}`,
        description: (
          <>
            <span>{item.lastFailure}</span>
            <span>Next: {item.nextAction}</span>
          </>
        ),
        actions: (
          <Button size="xs" variant="ghost" onClick={onOpenDetails}>
            View details
          </Button>
        ),
      }))}
    />
  );
}
