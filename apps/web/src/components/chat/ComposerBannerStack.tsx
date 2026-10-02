import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { XIcon } from "lucide-react";

import { useI18n } from "~/i18n";
import { cn } from "~/lib/utils";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";

const DISMISS_TRANSITION_MS = 220;

const dismissalStyle = {
  "--banner-dismiss-duration": `${DISMISS_TRANSITION_MS}ms`,
} satisfies CSSProperties;

// The collapsed cap peeking above the front banner is the only hint that more
// banners are stacked behind it, so its border must match the severity of the
// first hidden banner — a neutral banner must not masquerade as a warning.
const stackCapBorderClass: Record<ComposerBannerStackItem["variant"], string> = {
  default: "border-[var(--chat-composer-attached-outline)]",
  error: "border-destructive/24",
  info: "border-info/24",
  success: "border-success/24",
  warning: "border-warning/24",
};

export interface ComposerBannerStackItem {
  readonly id: string;
  readonly variant: "default" | "error" | "info" | "success" | "warning";
  // Ordering hint for stack assemblers: front this banner even though its
  // variant is calm (e.g. live update progress). The stack itself ignores it.
  readonly urgent?: boolean;
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly dismissLabel?: string;
  readonly onDismiss?: () => void;
}

interface ComposerBannerStackProps {
  readonly className?: string;
  readonly items: ReadonlyArray<ComposerBannerStackItem>;
}

export function ComposerBannerStack({ className, items }: ComposerBannerStackProps) {
  const [requestedExitingItemId, setExitingItemId] = useState<string | null>(null);
  const dismissTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const exitingItemId =
    requestedExitingItemId !== null && items.some((item) => item.id === requestedExitingItemId)
      ? requestedExitingItemId
      : null;

  useEffect(() => {
    return () => {
      if (dismissTimeoutRef.current) {
        clearTimeout(dismissTimeoutRef.current);
      }
    };
  }, []);

  if (items.length === 0) {
    return null;
  }

  const frontItem = items[0];

  if (!frontItem) {
    return null;
  }

  const stackedItems = items.slice(1);
  const hasStack = stackedItems.length > 0;
  const showCollapsedStackCap = hasStack && exitingItemId !== frontItem.id;
  const firstStackedItem = stackedItems[0];

  const requestDismiss = (item: ComposerBannerStackItem) => {
    if (!item.onDismiss || exitingItemId) {
      return;
    }

    setExitingItemId(item.id);

    if (dismissTimeoutRef.current) {
      clearTimeout(dismissTimeoutRef.current);
    }

    dismissTimeoutRef.current = setTimeout(() => {
      dismissTimeoutRef.current = null;
      item.onDismiss?.();
    }, DISMISS_TRANSITION_MS);
  };

  return (
    <div
      className={cn("group/banner-stack chat-composer-drawer-slot", className)}
      data-composer-banner-drawer="true"
    >
      <div
        className={cn(
          "relative flex flex-col-reverse",
          hasStack ? "group-hover/banner-stack:z-50 group-focus-within/banner-stack:z-50" : null,
        )}
      >
        {showCollapsedStackCap && firstStackedItem ? (
          <div
            className={cn(
              "pointer-events-none absolute inset-x-0 -top-3 z-0 mx-auto h-3 w-24/25 rounded-t-2xl",
              "chat-composer-banner-stack-cap border border-b-0 shadow-peek",
              stackCapBorderClass[firstStackedItem.variant],
              "transition-opacity duration-150 ease-out",
              "group-hover/banner-stack:opacity-0 group-focus-within/banner-stack:opacity-0",
            )}
            aria-hidden="true"
          />
        ) : null}
        <div
          className={cn(
            "relative z-10 composer-banner-dismissal",
            exitingItemId === frontItem.id
              ? "pointer-events-none composer-banner-exit-front"
              : "opacity-100 transform-none",
          )}
          style={dismissalStyle}
        >
          <ComposerBannerStackAlert
            item={frontItem}
            attached
            exiting={exitingItemId === frontItem.id}
            onDismissRequest={() => requestDismiss(frontItem)}
          />
        </div>
        {hasStack ? (
          <div
            data-composer-banner-stack-expanded-items="true"
            className={cn(
              "relative z-20 grid grid-rows-collapsed transition-grid-rows duration-150 ease-out",
              "group-hover/banner-stack:grid-rows-expanded group-focus-within/banner-stack:grid-rows-expanded",
            )}
          >
            <div className="min-h-0 overflow-hidden">
              <div
                className={cn(
                  "invisible pointer-events-none space-y-2 pb-2 opacity-0",
                  "translate-y-1 transform-gpu transition-transform-opacity duration-150 ease-out will-change-opacity-transform",
                  "group-hover/banner-stack:visible group-hover/banner-stack:pointer-events-auto group-hover/banner-stack:translate-y-0 group-hover/banner-stack:opacity-100",
                  "group-focus-within/banner-stack:visible group-focus-within/banner-stack:pointer-events-auto group-focus-within/banner-stack:translate-y-0 group-focus-within/banner-stack:opacity-100",
                )}
              >
                {stackedItems.map((item) => (
                  <div
                    key={item.id}
                    className={cn(
                      "composer-banner-dismissal",
                      exitingItemId === item.id
                        ? "pointer-events-none composer-banner-exit-stacked"
                        : "opacity-100 transform-none",
                    )}
                    style={dismissalStyle}
                  >
                    <ComposerBannerStackAlert
                      item={item}
                      attached={false}
                      exiting={exitingItemId === item.id}
                      onDismissRequest={() => requestDismiss(item)}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ComposerBannerStackAlert({
  item,
  attached,
  exiting,
  onDismissRequest,
}: {
  readonly item: ComposerBannerStackItem;
  readonly attached: boolean;
  readonly exiting: boolean;
  readonly onDismissRequest: () => void;
}) {
  const { t } = useI18n();
  const dismissOnly = item.onDismiss && !item.actions;

  const visualVariant =
    item.variant === "info" || item.variant === "success" ? "default" : item.variant;

  return (
    <Alert
      variant={visualVariant}
      presentation={attached ? "composer-drawer" : "glass"}
      data-variant={visualVariant}
    >
      {item.icon}
      <AlertTitle>{item.title}</AlertTitle>
      {item.description ? <AlertDescription>{item.description}</AlertDescription> : null}
      {item.actions || item.onDismiss ? (
        <AlertAction
          className={
            dismissOnly
              ? "max-sm:col-start-3 max-sm:row-start-1 max-sm:mt-0 max-sm:self-start"
              : undefined
          }
        >
          {item.actions}
          {item.onDismiss ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={item.dismissLabel ?? t("Dismiss warning")}
              disabled={exiting}
              onClick={onDismissRequest}
            >
              <XIcon className="size-3.5" />
            </Button>
          ) : null}
        </AlertAction>
      ) : null}
    </Alert>
  );
}
