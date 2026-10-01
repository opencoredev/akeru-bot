import { Toast } from "@base-ui/react/toast";
import { XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useI18n } from "~/i18n";
import { shouldRenderThreadScopedToast } from "./toast.logic";
import {
  deriveToastBodyDescriptor,
  ToastBodyContent,
  toastCornerDismissClass,
  toastCornerOrbClass,
} from "./ToastBody";
import { anchoredToastManager, handleToastDismissClick, type ThreadToastData } from "./toastState";
import { useActiveThreadRefFromRoute } from "./ThreadToastVisibleAutoDismiss";

export function AnchoredToastProvider({ children, ...props }: Toast.Provider.Props) {
  return (
    <Toast.Provider toastManager={anchoredToastManager} {...props}>
      {children}
      <AnchoredToasts />
    </Toast.Provider>
  );
}

function AnchoredToasts() {
  const { toasts } = Toast.useToastManager<ThreadToastData>();
  const activeThreadRef = useActiveThreadRefFromRoute();
  const { t } = useI18n();

  return (
    <Toast.Portal data-slot="toast-portal-anchored">
      <Toast.Viewport
        aria-label={t("Notifications")}
        className="outline-none"
        data-slot="toast-viewport-anchored"
      >
        {toasts
          .filter((toast) => shouldRenderThreadScopedToast(toast.data, activeThreadRef))
          .map((toast) => {
            const tooltipStyle = toast.data?.tooltipStyle ?? false;
            const positionerProps = toast.positionerProps;
            const bodyDescriptor = deriveToastBodyDescriptor(toast);
            const { stackedActionLayout, inlineContentEndPad } = bodyDescriptor;

            if (!positionerProps?.anchor) {
              return null;
            }

            return (
              <Toast.Positioner
                className="z-100 max-w-[min(--spacing(64),var(--available-width))]"
                data-slot="toast-positioner"
                key={toast.id}
                sideOffset={positionerProps.sideOffset ?? 4}
                toast={toast}
              >
                <Toast.Root
                  className={cn(
                    "dropdown-glass relative overflow-visible text-balance text-popover-foreground text-xs shadow-xl shadow-black/25 transition-[scale,opacity] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0",
                    tooltipStyle ? "rounded-md" : "rounded-lg",
                  )}
                  data-slot="toast-popup"
                  toast={toast}
                >
                  {tooltipStyle ? (
                    <Toast.Content className="pointer-events-auto px-2 py-1">
                      <Toast.Title data-slot="toast-title" />
                    </Toast.Content>
                  ) : (
                    <>
                      <div className={toastCornerDismissClass}>
                        <button
                          aria-label={t("Dismiss notification")}
                          className={toastCornerOrbClass}
                          data-slot="toast-close"
                          onClick={() =>
                            handleToastDismissClick(
                              anchoredToastManager,
                              toast.id,
                              toast.data?.onClose,
                            )
                          }
                          type="button"
                        >
                          <XIcon className="size-3" strokeWidth={2.25} />
                        </button>
                      </div>
                      <Toast.Content
                        className={cn(
                          "pointer-events-auto min-h-0 overflow-y-visible pl-3.5 text-sm [overflow-x:clip]",
                          stackedActionLayout
                            ? "flex flex-col gap-2 py-2.5 pr-3.5"
                            : cn(
                                "py-3",
                                "flex items-center justify-between gap-1.5",
                                inlineContentEndPad,
                              ),
                        )}
                      >
                        <ToastBodyContent
                          {...bodyDescriptor}
                          actionProps={toast.actionProps}
                          toastData={toast.data}
                          toastDescription={toast.description}
                          toastType={toast.type}
                        />
                      </Toast.Content>
                    </>
                  )}
                </Toast.Root>
              </Toast.Positioner>
            );
          })}
      </Toast.Viewport>
    </Toast.Portal>
  );
}
