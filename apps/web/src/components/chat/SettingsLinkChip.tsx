import { Settings02Icon } from "@hugeicons/core-free-icons";
import type { EnvironmentId } from "@akeru/contracts";
import type { MouseEvent, ReactNode } from "react";

import { useI18n } from "../../i18n";
import { openPlugins } from "../../pluginsDialogStore";
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
  environmentId,
  children,
  className,
}: {
  readonly href: string;
  readonly destination: SettingsDeepLinkDestination;
  readonly environmentId: EnvironmentId | null;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const { t } = useI18n();
  const tooltip = t("Open Settings > {destination}", { destination: t(destination.label) });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href={href}
            aria-label={tooltip}
            className={cn(
              CHAT_INLINE_CHIP_CLASS_NAME,
              "chat-markdown-settings-link cursor-pointer",
              className,
            )}
            onClick={(event: MouseEvent<HTMLAnchorElement>) => {
              event.preventDefault();
              event.stopPropagation();
              if (destination.section === "plugins") openPlugins();
              else openSettings(destination.section, destination.targetId, environmentId);
            }}
          >
            <AppIcon icon={Settings02Icon} className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} />
            <span className={CHAT_INLINE_CHIP_LABEL_CLASS_NAME}>{children}</span>
          </a>
        }
      />
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
