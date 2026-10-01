import { PanelLeftCloseIcon, PanelLeftIcon } from "lucide-react";
import * as React from "react";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Separator } from "~/components/ui/separator";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "~/components/ui/sheet";
import { useI18n } from "~/i18n";
import {
  SIDEBAR_RESIZE_DEFAULT_MIN_WIDTH,
  SIDEBAR_WIDTH_MOBILE,
  SidebarInstanceContext,
  type SidebarInstanceContextProps,
  SidebarProvider,
  type SidebarResizableOptions,
  type SidebarResolvedResizableOptions,
  useSidebar,
  useSidebarVisibility,
} from "./sidebarContext";
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "./sidebarMenu";
import { SidebarRail } from "./sidebarRail";

function Sidebar({
  side = "left",
  variant = "sidebar",
  collapsible = "offcanvas",
  resizable = false,
  surface,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  side?: "left" | "right";
  /** "app" paints the sidebar surface on the container; "app-bordered" adds the edge border. */
  surface?: "app" | "app-bordered";
  variant?: "sidebar" | "floating" | "inset";
  collapsible?: "offcanvas" | "icon" | "none";
  resizable?: boolean | SidebarResizableOptions;
}) {
  const { isMobile, state, openMobile, setOpenMobile } = useSidebar();
  const { t } = useI18n();

  const resolvedResizable = React.useMemo<SidebarResolvedResizableOptions | null>(() => {
    if (isMobile || collapsible === "none" || !resizable) {
      return null;
    }

    const options = typeof resizable === "boolean" ? {} : resizable;

    return {
      maxWidth: options.maxWidth ?? Number.POSITIVE_INFINITY,
      minWidth: options.minWidth ?? SIDEBAR_RESIZE_DEFAULT_MIN_WIDTH,
      storageKey: options.storageKey ?? null,
      ...(options.onResize ? { onResize: options.onResize } : {}),
      ...(options.shouldAcceptWidth ? { shouldAcceptWidth: options.shouldAcceptWidth } : {}),
    };
  }, [collapsible, isMobile, resizable]);

  const surfaceClassName = cn(
    surface && "bg-sidebar text-sidebar-foreground",
    surface === "app-bordered" && "border-r border-sidebar-border",
  );

  const instanceContextValue = React.useMemo<SidebarInstanceContextProps>(
    () => ({ side, resizable: resolvedResizable }),
    [resolvedResizable, side],
  );

  if (collapsible === "none") {
    return (
      <SidebarInstanceContext value={instanceContextValue}>
        <div
          className={cn(
            "flex h-full w-(--sidebar-width) flex-col bg-sidebar surface-grain text-sidebar-foreground",
            surfaceClassName,
            className,
          )}
          data-slot="sidebar"
          {...props}
        >
          {children}
        </div>
      </SidebarInstanceContext>
    );
  }

  if (isMobile) {
    return (
      <SidebarInstanceContext value={instanceContextValue}>
        <Sheet onOpenChange={setOpenMobile} open={openMobile} {...props}>
          <SheetPopup
            className={cn(
              "w-(--sidebar-width) max-w-none bg-sidebar surface-grain p-0 text-sidebar-foreground",
              surfaceClassName,
              className,
            )}
            data-mobile="true"
            data-sidebar="sidebar"
            data-slot="sidebar"
            showCloseButton={false}
            side={side}
            style={
              {
                "--sidebar-width": SIDEBAR_WIDTH_MOBILE,
              } as React.CSSProperties
            }
          >
            <SheetHeader className="sr-only">
              <SheetTitle>{t("Sidebar")}</SheetTitle>
              <SheetDescription>{t("Displays the mobile sidebar.")}</SheetDescription>
            </SheetHeader>
            <div
              className={cn(
                "flex h-full w-full flex-col pb-safe pt-safe",
                side === "left" ? "pl-safe" : "pr-safe",
              )}
            >
              {children}
            </div>
          </SheetPopup>
        </Sheet>
      </SidebarInstanceContext>
    );
  }

  return (
    <SidebarInstanceContext value={instanceContextValue}>
      <div
        className="group peer hidden text-sidebar-foreground md:block"
        data-collapsible={state === "collapsed" ? collapsible : ""}
        data-side={side}
        data-slot="sidebar"
        data-state={state}
        data-variant={variant}
      >
        {/* This is what handles the sidebar gap on desktop */}
        <div
          className={cn(
            "relative w-(--sidebar-width) bg-transparent transition-[width] duration-[320ms] ease-[cubic-bezier(0.22,1.18,0.36,1)] motion-reduce:transition-none",
            "group-data-[collapsible=offcanvas]:w-0",
            "group-data-[side=right]:rotate-180",
            variant === "floating" || variant === "inset"
              ? "group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]"
              : "group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
          )}
          data-slot="sidebar-gap"
        />
        <div
          className={cn(
            "fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) transition-[left,right,width] duration-[320ms] ease-[cubic-bezier(0.22,1.18,0.36,1)] motion-reduce:transition-none md:flex",
            side === "left"
              ? "left-0 group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]"
              : "right-0 group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)]",
            // Adjust the padding for floating and inset variants.
            variant === "floating" || variant === "inset"
              ? "p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]"
              : "group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r group-data-[side=right]:border-l",
            surfaceClassName,
            className,
          )}
          data-slot="sidebar-container"
          {...props}
        >
          <div
            className="flex h-full w-full flex-col bg-sidebar surface-grain group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border group-data-[variant=floating]:border-sidebar-border group-data-[variant=floating]:shadow-sm/5"
            data-sidebar="sidebar"
            data-slot="sidebar-inner"
          >
            {children}
          </div>
        </div>
      </div>
    </SidebarInstanceContext>
  );
}

/** `onStage` restyles the trigger for the white-on-artwork stage backdrop. */
function SidebarTrigger({
  className,
  onClick,
  onStage = false,
  ...props
}: React.ComponentProps<typeof Button> & { onStage?: boolean }) {
  const { toggleSidebar } = useSidebar();
  const isOpen = useSidebarVisibility();
  const { t } = useI18n();

  return (
    <Button
      className={cn(
        "size-[var(--workspace-titlebar-control-size)]! [-webkit-app-region:no-drag]",
        onStage &&
          "focus-visible:ring-white/90 [&_svg]:stroke-white/90! [&_svg]:opacity-100! [&_svg]:hover:stroke-white! [:hover,[data-pressed]]:bg-white/15 focus-visible:ring-offset-(--stage-art-bottom)",
        className,
      )}
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      aria-pressed={isOpen}
      onClick={(event) => {
        onClick?.(event);
        toggleSidebar();
      }}
      size="icon"
      variant="ghost"
      {...props}
    >
      <span className="relative size-[19px]" aria-hidden>
        <PanelLeftCloseIcon
          className={cn(
            "absolute inset-0 size-[19px] transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none",
            isOpen ? "scale-100 opacity-100" : "-rotate-12 scale-75 opacity-0",
          )}
          strokeWidth={1.55}
        />
        <PanelLeftIcon
          className={cn(
            "absolute inset-0 size-[19px] transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none",
            isOpen ? "rotate-12 scale-75 opacity-0" : "scale-100 opacity-100",
          )}
          strokeWidth={1.55}
        />
      </span>
      <span className="sr-only">{t("Toggle Sidebar")}</span>
    </Button>
  );
}

/** `tone` sets the page text color for full-height route surfaces. */
function SidebarInset({
  className,
  tone,
  ...props
}: React.ComponentProps<"main"> & { tone?: "foreground" | "muted" }) {
  return (
    <main
      className={cn(
        "relative flex min-w-0 w-full flex-1 flex-col bg-background surface-grain",
        "md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ms-2 md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ms-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm/5",
        tone === "foreground" && "text-foreground",
        tone === "muted" && "text-muted-foreground",
        className,
      )}
      data-slot="sidebar-inset"
      {...props}
    />
  );
}

function SidebarInput({ className, ...props }: React.ComponentProps<typeof Input>) {
  return (
    <Input
      className={cn("h-8 w-full bg-background shadow-none", className)}
      data-sidebar="input"
      data-slot="sidebar-input"
      {...props}
    />
  );
}

/** `dragRegion` lets the header drag the Electron window. */
function SidebarHeader({
  className,
  dragRegion = false,
  ...props
}: React.ComponentProps<"div"> & { dragRegion?: boolean }) {
  return (
    <div
      className={cn("flex flex-col gap-2 p-2", dragRegion && "drag-region", className)}
      data-sidebar="header"
      data-slot="sidebar-header"
      {...props}
    />
  );
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-2 p-2", className)}
      data-sidebar="footer"
      data-slot="sidebar-footer"
      {...props}
    />
  );
}

function SidebarSeparator({ className, ...props }: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      className={cn("mx-2 w-auto! bg-sidebar-border", className)}
      data-sidebar="separator"
      data-slot="sidebar-separator"
      {...props}
    />
  );
}

function SidebarContent({
  className,
  fixedHeader,
  scrollAnchoring = true,
  ...props
}: React.ComponentProps<"div"> & {
  fixedHeader?: React.ReactNode;
  /** Set false when rows reorder in place, so the browser does not shift the scroll position. */
  scrollAnchoring?: boolean;
}) {
  return (
    <>
      {fixedHeader ? <div className="w-full shrink-0">{fixedHeader}</div> : null}
      <ScrollArea hideScrollbars scrollFade className="h-auto min-h-0 flex-1">
        <div
          className={cn(
            "flex w-full min-w-0 flex-col gap-2 group-data-[collapsible=icon]:overflow-hidden",
            !scrollAnchoring && "overflow-anchor-none",
            className,
          )}
          data-sidebar="content"
          data-slot="sidebar-content"
          {...props}
        />
      </ScrollArea>
    </>
  );
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
  useSidebarVisibility,
};
