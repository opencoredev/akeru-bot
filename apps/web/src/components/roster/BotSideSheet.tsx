import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import {
  Sheet,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "../ui/sheet";

/**
 * Right-side sheet shared by the bot settings sheets (tools, memory, channels).
 * Keeps the backdrop, header, body padding, and section spacing identical across them.
 * `toolbar` sits under the description and stays fixed while the body scrolls.
 */
export function BotSideSheet({
  open,
  onOpenChange,
  title,
  description,
  toolbar,
  footer,
  className,
  children,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: ReactNode;
  readonly description: ReactNode;
  readonly toolbar?: ReactNode;
  readonly footer?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup side="right" forceBackdrop className={cn("max-w-lg", className)}>
        <SheetHeader className="gap-1 border-b px-6 pt-5 pb-4 pe-12">
          <SheetTitle className="text-base leading-6">{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
          {toolbar ? <div className="mt-3">{toolbar}</div> : null}
        </SheetHeader>
        <SheetPanel className="px-6 pb-6">
          <div className="space-y-6 pt-4">{children}</div>
        </SheetPanel>
        {footer ? <SheetFooter>{footer}</SheetFooter> : null}
      </SheetPopup>
    </Sheet>
  );
}

/** Titled group inside a BotSideSheet body. */
export function BotSideSheetSection({
  title,
  description,
  action,
  children,
  className,
  ...props
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  readonly children: ReactNode;
} & Omit<React.ComponentProps<"section">, "title">) {
  return (
    <section className={cn("space-y-3", className)} {...props}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{title}</h3>
          {description ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** Centered empty or unavailable state for a BotSideSheet body. */
export function BotSideSheetEmpty({
  icon: Icon,
  title,
  description,
  action,
}: {
  readonly icon: LucideIcon;
  readonly title: ReactNode;
  readonly description: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <Empty className="gap-4 px-0 py-12 md:px-0 md:py-12">
      <EmptyHeader>
        <EmptyMedia variant="icon" className="mb-4">
          <Icon />
        </EmptyMedia>
        <EmptyTitle className="font-sans text-sm font-medium">{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}
