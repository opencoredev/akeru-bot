import { Settings02Icon } from "@hugeicons/core-free-icons";
import type { MouseEvent, ReactNode } from "react";

import { openSettings } from "../../settingsDialogStore";
import type { SettingsDeepLinkDestination } from "../../settingsDeepLink";
import { cn } from "../../lib/utils";
import {
  CHAT_INLINE_CHIP_CLASS_NAME,
  CHAT_INLINE_CHIP_LABEL_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
} from "../composerInlineChip";
import { AppIcon } from "../ui/app-icon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SettingsLinkChip({
  href,
  destination,
  children,
  className,
}: {
  readonly href: string;
  readonly destination: SettingsDeepLinkDestination;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href={href}
            aria-label={destination.tooltip}
            className={cn(
              CHAT_INLINE_CHIP_CLASS_NAME,
              "chat-markdown-settings-link cursor-pointer",
              className,
            )}
            onClick={(event: MouseEvent<HTMLAnchorElement>) => {
              event.preventDefault();
              event.stopPropagation();
              openSettings(destination.section, destination.targetId);
            }}
          >
            <AppIcon icon={Settings02Icon} className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} />
            <span className={CHAT_INLINE_CHIP_LABEL_CLASS_NAME}>{children}</span>
          </a>
        }
      />
      <TooltipPopup side="top">{destination.tooltip}</TooltipPopup>
    </Tooltip>
  );
}
