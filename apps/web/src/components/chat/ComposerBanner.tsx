import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { ChevronDownIcon, XIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { Button, buttonVariants } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";

export type ComposerBannerVariant = "default" | "error" | "info" | "success" | "warning";

const surfaceColors = "composer-banner-surface-colors";

const neutralOutline = "composer-banner-outline-neutral";

const variantColors: Record<ComposerBannerVariant, string> = {
  default: neutralOutline,
  error: "composer-banner-outline-error",
  info: neutralOutline,
  success: neutralOutline,
  warning: "composer-banner-outline-warning",
};

/** Shared glass and attachment seam, also used by the command menu without banner row padding. */
function Surface({
  placement = "attached",
  variant = "default",
  className,
  ...props
}: ComponentProps<"div"> & {
  placement?: "attached" | "floating";
  variant?: ComposerBannerVariant;
}) {
  return (
    <div
      data-composer-banner-surface={placement}
      data-variant={variant}
      className={cn(
        surfaceColors,
        "relative isolate border-0 bg-transparent shadow-none composer-banner-glass",
        variantColors[variant],
        placement === "attached"
          ? "composer-banner-overlap-attached before:rounded-t-16px"
          : "composer-banner-overlap-none before:rounded-1rem",
        "before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:border before:border-(--chat-composer-attached-outline)",
        "before:bg-composer-glass before:backdrop-blur-(--glass-blur) before:backdrop-saturate-(--glass-saturation)",
        "before:shadow-composer-banner dark:before:shadow-composer-banner-dark",
        "not-supports-[(backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px))]:before:bg-(--chat-composer-attached-surface)",
        className,
      )}
      {...props}
    />
  );
}

// A peeking notice uses the first hidden notice's severity, never the attached row's.
const peekBorder: Record<ComposerBannerVariant, string> = {
  default: "border-(--chat-composer-attached-outline)",
  error: "border-destructive/24",
  info: "border-(--chat-composer-attached-outline)",
  success: "border-(--chat-composer-attached-outline)",
  warning: "border-warning/24",
};

function Peek({
  className,
  variant = "default",
  ...props
}: ComponentProps<"button"> & { variant?: ComposerBannerVariant }) {
  return (
    <button
      type="button"
      data-slot="composer-banner-peek"
      className={cn(
        surfaceColors,
        neutralOutline,
        "absolute inset-x-0 bottom-0 z-0 mx-auto h-3 w-24/25 cursor-pointer rounded-t-2xl border border-b-0 shadow-peek",
        "bg-composer-glass backdrop-blur-(--glass-blur) backdrop-saturate-(--glass-saturation)",
        "not-supports-[(backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px))]:bg-(--chat-composer-attached-surface)",
        "transition-opacity duration-150 ease-out focus-visible:outline-2 focus-visible:outline-ring",
        peekBorder[variant],
        className,
      )}
      {...props}
    />
  );
}

function Attachment({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-banner-attachment"
      className={cn(
        "mx-auto -mb-composer-seam w-composer-drawer",
        // Adjacent attachments share their outline, including notices outside the form.
        "[&+[data-slot=composer-banner-attachment]_[data-composer-banner-surface=attached]]:before:rounded-none [&+[data-slot=composer-banner-attachment]_[data-composer-banner-surface=attached]]:before:border-t-0",
        "[&+:has([data-chat-composer-form])_[data-chat-composer-form]>[data-slot=composer-banner-attachment]:first-child_[data-composer-banner-surface=attached]]:before:rounded-none [&+:has([data-chat-composer-form])_[data-chat-composer-form]>[data-slot=composer-banner-attachment]:first-child_[data-composer-banner-surface=attached]]:before:border-t-0",
        className,
      )}
      {...props}
    />
  );
}

function Dock({ className, ...props }: ComponentProps<"div">) {
  return (
    <Attachment
      className={cn(
        "flex items-end gap-1 not-has-data-[composer-banner-surface=attached]:hidden",
        className,
      )}
      {...props}
    />
  );
}

/** Attachments share a column while neighboring tabs keep their own surface. */
function Column({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 flex-col empty:hidden",
        "[&>[data-slot=composer-banner-attachment]]:w-full [&>[data-slot=composer-banner-attachment]:last-child]:mb-0",
        className,
      )}
      {...props}
    />
  );
}

function Root({
  className,
  placement = "attached",
  variant = "default",
  width = "fill",
  ...props
}: ComponentProps<"div"> & {
  placement?: "attached" | "floating";
  variant?: ComposerBannerVariant;
  width?: "fill" | "content";
}) {
  return (
    <Surface
      className={cn(
        "min-w-0 p-1 pb-composer-overlap-1 text-xs/4 composer-banner-icon-column",
        width === "content" ? "w-fit max-w-full flex-none" : "@container",
        className,
      )}
      data-slot="composer-banner"
      placement={placement}
      data-composer-banner-width={width}
      variant={variant}
      {...props}
    />
  );
}

/** The same row can be a status, a list item, or an entire disclosure button. */
function Row({
  className,
  render,
  layout = "inline",
  ...props
}: useRender.ComponentProps<"div"> & {
  layout?: "inline" | "wrap-actions";
}) {
  const rowProps = {
    className: cn(
      "group/banner-row grid min-h-(--composer-banner-icon-column) w-full min-w-0 grid-cols-banner-row items-center gap-x-1 text-start",
      "not-has-[>[data-slot=composer-banner-actions]]:grid-cols-banner-row-plain",
      "[&:is(button)]:cursor-pointer [&:is(button)]:rounded-0.5rem [&:is(button)]:focus-visible:outline-2 [&:is(button)]:focus-visible:-outline-offset-2 [&:is(button)]:focus-visible:outline-ring",
      layout === "wrap-actions" &&
        "@max-[400px]:flex @max-[400px]:flex-wrap @max-[400px]:gap-y-1 @max-[400px]:*:data-[slot=composer-banner-actions]:ms-auto @max-[400px]:*:data-[slot=composer-banner-actions]:max-w-full @max-[400px]:has-[>[data-slot=composer-banner-icon]]:*:data-[slot=composer-banner-actions]:max-w-banner-actions-wrapped @max-[400px]:*:data-[slot=composer-banner-content]:min-h-(--composer-banner-icon-column) @max-[400px]:*:data-[slot=composer-banner-content]:grow @max-[400px]:*:data-[slot=composer-banner-content]:shrink @max-[400px]:*:data-[slot=composer-banner-content]:basis-40",
      className,
    ),
    "data-composer-banner-row": "true",
    "data-composer-banner-layout": layout,
  };

  return useRender({
    defaultTagName: "div",
    render,
    props: mergeProps<"div">(rowProps, props),
  });
}

function Icon({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      aria-hidden
      data-slot="composer-banner-icon"
      className={cn(
        "col-start-1 row-start-1 flex w-(--composer-banner-icon-column) min-w-0 flex-none items-center justify-center text-muted-foreground [&>svg]:size-3",
        className,
      )}
      {...props}
    />
  );
}

function Content({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="composer-banner-content"
      className={cn(
        "col-start-2 row-start-1 flex min-w-0 items-center gap-1 *:data-[slot=composer-banner-separator]:mx-0",
        "group-not-has-[>[data-slot=composer-banner-icon]]/banner-row:col-start-1 group-not-has-[>[data-slot=composer-banner-icon]]/banner-row:col-end-3 group-not-has-[>[data-slot=composer-banner-icon]]/banner-row:ps-2 sm:group-not-has-[>[data-slot=composer-banner-icon]]/banner-row:ps-1.5",
        "group-not-has-[>[data-slot=composer-banner-icon],>[data-slot=composer-banner-actions]]/banner-row:pe-2 sm:group-not-has-[>[data-slot=composer-banner-icon],>[data-slot=composer-banner-actions]]/banner-row:pe-1.5",
        className,
      )}
      {...props}
    />
  );
}

function Separator() {
  return (
    <span
      aria-hidden
      data-slot="composer-banner-separator"
      className="mx-1 inline-block flex-none text-muted-foreground/40"
    >
      ·
    </span>
  );
}

function Actions({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="composer-banner-actions"
      className={cn(
        "col-start-3 row-start-1 flex flex-wrap items-center justify-end gap-1",
        className,
      )}
      {...props}
    />
  );
}

/** Child rows keep their parent's columns and begin immediately after its header. */
function Children({ className, render, ...props }: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    render,
    props: mergeProps<"div">(
      { className: cn("grid gap-px [&_[data-composer-banner-row]]:min-h-5", className) },
      props,
    ),
  });
}

/** Bounded banner content uses the app's scroll area and fades only overflowing edges. */
function Scroll({ className, ...props }: ComponentProps<typeof ScrollArea>) {
  return (
    <ScrollArea
      scrollFade
      variant="square"
      className={cn(
        "h-auto max-h-(--spacing-min-24rem-40dvh) [&>[data-slot=scroll-area-viewport][data-has-overflow-y]]:pe-2",
        className,
      )}
      {...props}
    />
  );
}

function Count({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "inline-flex min-w-(--composer-banner-icon-column,1em) flex-none justify-center font-medium text-muted-foreground tabular-nums",
        className,
      )}
      {...props}
    />
  );
}

function Body({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("min-w-0 ps-banner-indent", className)} {...props} />;
}

function Dot({ className, ...props }: ComponentProps<"span">) {
  return (
    <span className={cn("size-1.5 flex-none rounded-full bg-current", className)} {...props} />
  );
}

function ToggleIcon({ expanded, className }: { expanded: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        buttonVariants({ size: "icon-xs", variant: "ghost" }),
        "pointer-events-none",
        className,
      )}
    >
      <ChevronDownIcon className={cn("size-3.5", !expanded && "rotate-180")} />
    </span>
  );
}

function Dismiss({ className, children, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button size="icon-xs" variant="ghost" className={className} {...props}>
      {children ?? <XIcon className="size-3.5" />}
    </Button>
  );
}

export const ComposerBanner = {
  Surface,
  Peek,
  Attachment,
  Dock,
  Column,
  Root,
  Row,
  Icon,
  Content,
  Separator,
  Actions,
  Children,
  Scroll,
  Count,
  Body,
  Dot,
  ToggleIcon,
  Dismiss,
};
