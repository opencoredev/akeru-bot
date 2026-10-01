import {
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor } from "@dnd-kit/modifiers";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { cn } from "../../lib/utils";
import {
  planRosterDrop,
  resolveRosterDropTarget,
  rosterItemKey,
  rosterListItemId,
  rosterMarkerId,
  type RosterItemRef,
  type RosterListItem,
  type RosterListMarker,
  type RosterZone,
} from "./roster.logic";
import {
  animateRosterLayoutChanges,
  createRosterCollisionDetection,
  createRosterSortingStrategy,
  restrictBelowRosterLabel,
  restrictRosterDragAxis,
} from "./roster.drag";
import { createRosterListMotion } from "./roster.motion";
import { RosterPointerSensor } from "./roster.pointer";
import { useRosterStore } from "./rosterStore";

export type SortableRosterRowBag = Pick<
  ReturnType<typeof useSortable>,
  "listeners" | "setNodeRef" | "transform" | "transition" | "isDragging"
>;

export function SortableRosterRow(props: {
  id: string;
  disabled: boolean;
  children: (bag: SortableRosterRowBag) => ReactNode;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.id,
    disabled: { draggable: props.disabled },
    animateLayoutChanges: animateRosterLayoutChanges,
  });

  const bag = useMemo(
    () => ({ listeners, setNodeRef, transform, transition, isDragging }),
    [listeners, setNodeRef, transform, transition, isDragging],
  );

  return props.children(bag);
}

export function sortableRootProps(sortable: SortableRosterRowBag) {
  return {
    ref: sortable.setNodeRef,
    style: {
      transform: CSS.Translate.toString(sortable.transform),
      transition: sortable.transition,
      visibility:
        !sortable.isDragging && sortable.transform?.scaleY === 0 ? ("hidden" as const) : undefined,
    },
    ...sortable.listeners,
  };
}

export const ROSTER_DRAG_LABEL_HEIGHT = 24;

export function SortableRosterMarker(props: {
  marker: RosterListMarker;
  className?: string;
  children?: ReactNode;
  draggable?: boolean;
  "data-testid"?: string;
}) {
  const { setNodeRef, transform, transition, listeners } = useSortable({
    id: rosterMarkerId(props.marker),
    disabled: { draggable: props.draggable !== true },
    animateLayoutChanges: animateRosterLayoutChanges,
  });

  return (
    <li
      ref={setNodeRef}
      data-testid={props["data-testid"]}
      className={cn("list-none", props.className)}
      /* oxlint-disable shadcn/no-inline-styles -- dnd-kit drag geometry, updated every pointer move. */
      style={{
        transform: CSS.Translate.toString(transform),
        transition:
          typeof props.marker !== "string" && props.marker.kind === "section-placeholder"
            ? "none"
            : props.marker === "unassigned-placeholder"
              ? "none"
              : transition,
        visibility: transform?.scaleY === 0 ? "hidden" : undefined,
      }}
      /* oxlint-enable shadcn/no-inline-styles */
      {...(props.draggable ? listeners : {})}
    >
      {props.children}
    </li>
  );
}

export function RosterDragBoundary(props: {
  marker: "pinned-header" | "pinned-divider";
  label: string | null;
  visible: boolean;
  isDropTarget: boolean;
}) {
  return (
    <SortableRosterMarker
      marker={props.marker}
      data-testid={`roster-${props.marker}`}
      className="pointer-events-none relative mx-0.5 -mb-px h-0 w-full flex-none"
    >
      {props.visible ? (
        <div
          aria-hidden={props.label === null ? true : undefined}
          className={cn(
            "roster-drag-boundary-label absolute inset-x-2 top-1 h-4",
            props.label !== null && "flex items-center gap-2",
          )}
        >
          {props.label !== null ? (
            <>
              <span
                className={cn(
                  "shrink-0 text-xs font-medium",
                  props.isDropTarget ? "text-primary" : "text-sidebar-foreground/80",
                )}
              >
                {props.label}
              </span>
              <span
                aria-hidden
                className={cn(
                  "h-px flex-1",
                  props.isDropTarget ? "bg-primary/50" : "bg-sidebar-foreground/25",
                )}
              />
            </>
          ) : null}
        </div>
      ) : null}
    </SortableRosterMarker>
  );
}

export function RosterSectionPlaceholder(props: {
  marker: RosterListMarker;
  label: string;
  showHint: boolean;
  isDropTarget: boolean;
}) {
  return (
    <SortableRosterMarker
      marker={props.marker}
      data-testid="roster-section-placeholder"
      className="relative mx-0.5 -mb-px h-0 w-full flex-none"
    >
      {props.showHint ? (
        <div
          className={cn(
            "absolute inset-x-0 top-0 flex h-9 items-center justify-center rounded-md border border-dashed border-sidebar-foreground/25 text-xs text-sidebar-foreground/80",
            props.isDropTarget && "border-primary/40 bg-primary/5 text-primary",
          )}
        >
          {props.label}
        </div>
      ) : null}
    </SortableRosterMarker>
  );
}

/**
 * Drag state and dnd-kit wiring for the roster list. The list's zones come
 * from `items`; a drop is planned against `pinnedOrder` and applied to the
 * roster store. Spread `dndContextProps` on `DndContext`, attach `listRef` to
 * the sortable list, and mount `RosterDragLifecycle` with `cancelRosterDrag`.
 */
export function useRosterDragController({
  rosterListItems,
  visiblePinnedItems,
}: {
  rosterListItems: readonly RosterListItem[];
  visiblePinnedItems: readonly RosterItemRef[];
}) {
  const zoneByEntryId = useMemo(() => {
    const map = new Map<string, RosterZone>();

    for (const item of rosterListItems) {
      if (item.kind === "entry") map.set(rosterListItemId(item), item.zone);
    }

    return map;
  }, [rosterListItems]);

  const [dragState, setDragState] = useState<{
    readonly activeId: string;
    readonly from: RosterZone;
    readonly targetZone: RosterZone | null;
    readonly activationY: number | null;
  } | null>(null);

  const listMotionRef = useRef<ReturnType<typeof createRosterListMotion> | null>(null);
  const rosterListRef = useRef<HTMLUListElement | null>(null);
  const dragLabelOffsetRef = useRef(0);
  const dragSensorRef = useRef<RosterPointerSensor | null>(null);

  const attachListMotionRef = useCallback((node: HTMLUListElement | null) => {
    rosterListRef.current = node;
    listMotionRef.current?.dispose();
    listMotionRef.current = node === null ? null : createRosterListMotion(node);
    listMotionRef.current?.update(false);
  }, []);

  const finishRosterDrag = useCallback((started: boolean) => {
    dragSensorRef.current = null;

    if (started) {
      listMotionRef.current?.release();
      setDragState(null);
    }
  }, []);

  const attachDragSensor = useCallback((sensor: RosterPointerSensor) => {
    dragSensorRef.current = sensor;
  }, []);

  const cancelRosterDrag = useCallback(() => {
    dragSensorRef.current?.cancel();
  }, []);

  const dndSensors = useSensors(
    useSensor(RosterPointerSensor, {
      distance: 6,
      onAttach: attachDragSensor,
      onFinish: finishRosterDrag,
    }),
  );

  const restrictBelowPins = useCallback(
    (args: Parameters<typeof restrictBelowRosterLabel>[0]) =>
      restrictBelowRosterLabel(args, dragLabelOffsetRef.current),
    [],
  );

  const restrictRosterAxis = useCallback(
    (args: Parameters<typeof restrictRosterDragAxis>[0]) =>
      restrictRosterDragAxis(args, zoneByEntryId.get(String(args.active?.id)) ?? null),
    [zoneByEntryId],
  );

  const handleRosterDragStart = useCallback(
    (event: DragStartEvent) => {
      const activeId = String(event.active.id);
      const from = zoneByEntryId.get(activeId);

      if (from === undefined) return;
      listMotionRef.current?.suspend();
      const list = rosterListRef.current;
      const header = list?.querySelector<HTMLElement>('[data-testid="roster-pinned-header"]');

      if (list && header) {
        const listRect = list.getBoundingClientRect();
        const scale = list.offsetWidth > 0 ? listRect.width / list.offsetWidth : 1;
        dragLabelOffsetRef.current =
          header.getBoundingClientRect().top - listRect.top + ROSTER_DRAG_LABEL_HEIGHT * scale;
      } else {
        dragLabelOffsetRef.current = 0;
      }

      setDragState({
        activeId,
        from,
        targetZone: from,
        activationY:
          event.activatorEvent instanceof PointerEvent ? event.activatorEvent.clientY : null,
      });
    },
    [zoneByEntryId],
  );

  const handleRosterDragOver = useCallback(
    (event: DragOverEvent) => {
      const activeId = String(event.active.id);

      const target = event.over
        ? resolveRosterDropTarget(rosterListItems, activeId, String(event.over.id), null)
        : null;

      setDragState((current) =>
        current === null || current.activeId !== activeId
          ? current
          : { ...current, targetZone: target?.zone ?? null },
      );
    },
    [rosterListItems],
  );

  const handleRosterDragEnd = useCallback(
    (event: DragEndEvent) => {
      const activeId = String(event.active.id);
      const overId = event.over ? String(event.over.id) : null;

      if (overId === null) return;
      const from = zoneByEntryId.get(activeId);
      const target = resolveRosterDropTarget(rosterListItems, activeId, overId, null);

      if (from === undefined || target === null) return;
      useRosterStore.getState().applyRosterDrop(
        planRosterDrop({
          activeId,
          from,
          target,
          pinnedOrder: visiblePinnedItems,
        }),
      );
    },
    [rosterListItems, visiblePinnedItems, zoneByEntryId],
  );

  useEffect(() => {
    if (
      dragState !== null &&
      !rosterListItems.some((item) => rosterListItemId(item) === dragState.activeId)
    ) {
      cancelRosterDrag();
    }
  }, [cancelRosterDrag, dragState, rosterListItems]);
  const listMotionPaused = dragState !== null;

  const rosterListOrderKey = useMemo(
    () =>
      rosterListItems
        .map((item) =>
          item.kind === "entry"
            ? `${rosterItemKey(item.item)}:${rosterListItemId(item)}`
            : rosterListItemId(item),
        )
        .join("\0"),
    [rosterListItems],
  );

  useLayoutEffect(() => {
    void rosterListOrderKey;
    listMotionRef.current?.update(!listMotionPaused && rosterListItems.length > 0);
  }, [listMotionPaused, rosterListItems.length, rosterListOrderKey]);
  const sortableIds = useMemo(() => rosterListItems.map(rosterListItemId), [rosterListItems]);

  const rosterSortingStrategy = useMemo(
    () =>
      createRosterSortingStrategy({
        items: rosterListItems,
        boundaryLabelHeight: ROSTER_DRAG_LABEL_HEIGHT,
      }),
    [rosterListItems],
  );

  const dndCollisionDetection = useMemo(
    () =>
      createRosterCollisionDetection(
        (id) => {
          if (dragState === null) return true;

          return resolveRosterDropTarget(rosterListItems, dragState.activeId, id, null) !== null;
        },
        {
          items: rosterListItems,
          activationY: dragState?.activationY ?? null,
        },
      ),
    [dragState, rosterListItems],
  );

  const dragTargetZone = dragState?.targetZone ?? null;

  const modifiers = useMemo(
    () => [restrictRosterAxis, restrictBelowPins, restrictToFirstScrollableAncestor],
    [restrictBelowPins, restrictRosterAxis],
  );

  return {
    dragState,
    dragTargetZone,
    rosterListRef,
    listRef: attachListMotionRef,
    cancelRosterDrag,
    sortableIds,
    sortingStrategy: rosterSortingStrategy,
    dndContextProps: {
      sensors: dndSensors,
      collisionDetection: dndCollisionDetection,
      modifiers,
      onDragStart: handleRosterDragStart,
      onDragOver: handleRosterDragOver,
      onDragEnd: handleRosterDragEnd,
    },
  };
}
