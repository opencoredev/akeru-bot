import { closestCenter, type CollisionDetection, type Modifier } from "@dnd-kit/core";
import {
  defaultAnimateLayoutChanges,
  verticalListSortingStrategy,
  type AnimateLayoutChanges,
  type SortingStrategy,
} from "@dnd-kit/sortable";

import {
  parseRosterEntryId,
  parseRosterSectionHeaderId,
  resolveRosterDropTarget,
  rosterListItemId,
  rosterMarkerId,
  type RosterListItem,
  type RosterListMarker,
  type RosterZone,
} from "./roster.logic";

const stationary = { x: 0, y: 0, scaleX: 1, scaleY: 1 };
const hidden = { ...stationary, scaleY: 0 };
type Layout = Parameters<SortingStrategy>[0];

/** Sortable transforms own dragging; replaying the committed DOM order would
 * animate the drop twice. */
export const animateRosterLayoutChanges: AnimateLayoutChanges = (args) =>
  args.isSorting ? defaultAnimateLayoutChanges(args) : false;

/** Keep the lifted card below the Pins label, including when Pins is empty.
 * The container rect follows scrolling; the offset is measured once at pickup. */
export function restrictBelowRosterLabel(
  { transform, containerNodeRect, draggingNodeRect }: Parameters<Modifier>[0],
  offset: number,
) {
  if (!containerNodeRect || !draggingNodeRect) return transform;
  const minimumY = containerNodeRect.top + offset - draggingNodeRect.top;
  return transform.y < minimumY ? { ...transform, y: minimumY } : transform;
}

function markerIsPinnedBoundary(marker: RosterListMarker): boolean {
  return marker === "pinned-header" || marker === "pinned-divider";
}

/** Reject the nearest unsupported target without selecting another section.
 * Recreate this detector when drop eligibility changes. */
export function createRosterCollisionDetection(
  isValidTarget: (id: string) => boolean,
  options: {
    items?: readonly RosterListItem[];
    activationY?: number | null;
    firstSectionId?: string | null;
  } = {},
): CollisionDetection {
  const validity = new Map<string, boolean>();
  const zones = new Map<string, RosterZone | null>();
  let previousPointerY = options.activationY;
  let boundaryZone: "pinned" | "rest" | undefined;
  return (args) => {
    let collisions = closestCenter(args);
    const pointer = args.pointerCoordinates;
    const items = options.items;
    const source = items?.find(
      (item) => item.kind === "entry" && rosterListItemId(item) === String(args.active.id),
    );
    const boundary = args.droppableContainers
      .find((container) => container.id === rosterMarkerId("pinned-divider"))
      ?.node.current?.querySelector(".roster-drag-boundary-label")
      ?.getBoundingClientRect();
    if (items && boundary && source?.kind === "entry" && pointer) {
      boundaryZone ??= source.zone === "pinned" ? "pinned" : "rest";
      const previousY = previousPointerY ?? pointer.y;
      previousPointerY = pointer.y;
      if (pointer.x >= boundary.left && pointer.x <= boundary.right) {
        if (pointer.y < previousY && pointer.y <= boundary.bottom) boundaryZone = "pinned";
        else if (pointer.y > previousY && pointer.y >= boundary.top) boundaryZone = "rest";
        const restTop = args.droppableContainers
          .find((container) => {
            const id = String(container.id);
            return (
              parseRosterSectionHeaderId(id) !== null || id === rosterMarkerId("unassigned-header")
            );
          })
          ?.node.current?.getBoundingClientRect().top;
        if (boundaryZone === "pinned" || (restTop != null && pointer.y < restTop)) {
          const target = collisions.find((collision) => {
            const id = String(collision.id);
            if (!zones.has(id)) {
              zones.set(
                id,
                resolveRosterDropTarget(
                  items,
                  String(args.active.id),
                  id,
                  options.firstSectionId ?? null,
                )?.zone ?? null,
              );
            }
            const zone = zones.get(id);
            if (zone == null) return false;
            return boundaryZone === "pinned" ? zone === "pinned" : zone !== "pinned";
          });
          if (target)
            collisions = [target, ...collisions.filter((collision) => collision !== target)];
        }
      }
    }
    const nearest = collisions[0];
    if (!nearest || nearest.id === args.active.id) {
      return collisions;
    }
    const id = String(nearest.id);
    const valid = validity.get(id) ?? isValidTarget(id);
    validity.set(id, valid);
    return valid ? collisions : collisions.filter((collision) => collision.id === args.active.id);
  };
}

/** Preview the committed section layout without moving or mounting DOM nodes.
 * A zero scaleY marks rows/markers to hide while retaining their measured nodes. */
export function createRosterSortingStrategy(input: {
  items: readonly RosterListItem[];
  firstSectionId?: string | null;
  cardHeight?: number;
  slimHeight?: number;
  headerHeight?: number;
  /** Space each pinned boundary opens for its label while dragging. The
   * markers stay zero height at rest, so nothing is reserved until pickup. */
  boundaryLabelHeight?: number;
}): SortingStrategy {
  const { items } = input;
  const indices = new Map(items.map((item, index) => [rosterListItemId(item), index]));
  let previous: Pick<Layout, "rects" | "activeIndex" | "overIndex"> | undefined;
  let transforms: ReturnType<SortingStrategy>[] | null = [];

  function project({ rects, activeIndex, overIndex }: Layout) {
    const active = items[activeIndex];
    const over = items[overIndex] ?? active;
    if (!active || !over || !rects[0]) return [];
    if (active.kind === "marker") {
      const sectionId =
        typeof active.marker === "object" && active.marker.kind === "section-header"
          ? active.marker.sectionId
          : parseRosterSectionHeaderId(rosterListItemId(active));
      if (!sectionId) return [];
      return projectSectionReorder({
        rects,
        activeIndex,
        overIndex,
        sectionId,
        activeNodeRect: null,
        index: activeIndex,
      });
    }
    const target = resolveRosterDropTarget(
      items,
      rosterListItemId(active),
      rosterListItemId(over),
      input.firstSectionId ?? null,
    );
    if (!target) return [];
    const groups = new Map<string, Extract<RosterListItem, { kind: "entry" }>[]>();
    const remember = (zone: RosterZone) => {
      const id = zone === "pinned" || zone === "unassigned" ? zone : zone.sectionId;
      if (!groups.has(id)) groups.set(id, []);
      return groups.get(id)!;
    };
    let cardHeight = input.cardHeight;
    let slimHeight = input.slimHeight;
    let headerHeight = input.headerHeight;
    for (const [index, item] of items.entries()) {
      if (item.kind === "marker") {
        if (
          item.marker === "unassigned-header" ||
          (typeof item.marker === "object" && item.marker.kind === "section-header")
        ) {
          const height = rects[index]?.height;
          if (height) headerHeight ??= height;
        }
        continue;
      }
      cardHeight ??= rects[index]?.height;
      if (item.item.kind !== active.item.kind || item.item.id !== active.item.id) {
        remember(item.zone).push(item);
      }
    }
    cardHeight ??= 52;
    slimHeight ??= 36;
    headerHeight ??= 32;
    const labelHeight = input.boundaryLabelHeight ?? 0;
    const moved: Extract<RosterListItem, { kind: "entry" }> = { ...active, zone: target.zone };
    const destination = remember(target.zone);
    const ranks = new Map(target.order.map((item, index) => [`${item.kind}:${item.id}`, index]));
    const rank = ranks.get(`${active.item.kind}:${active.item.id}`) ?? Number.POSITIVE_INFINITY;
    const insertAt = destination.findIndex(
      (item) => (ranks.get(`${item.item.kind}:${item.item.id}`) ?? Number.POSITIVE_INFINITY) > rank,
    );
    destination.splice(insertAt < 0 ? destination.length : insertAt, 0, moved);

    const projected: RosterListItem[] = [];
    const marker = (name: RosterListMarker) => projected.push({ kind: "marker", marker: name });
    marker("pinned-header");
    projected.push(...(groups.get("pinned") ?? []));
    marker("pinned-divider");
    const sectionIds: string[] = [];
    for (const item of items) {
      if (
        item.kind === "marker" &&
        typeof item.marker === "object" &&
        item.marker.kind === "section-header" &&
        !sectionIds.includes(item.marker.sectionId)
      ) {
        sectionIds.push(item.marker.sectionId);
      }
    }
    for (const sectionId of sectionIds) {
      marker({ kind: "section-header", sectionId });
      marker({ kind: "section-placeholder", sectionId });
      projected.push(...(groups.get(sectionId) ?? []));
    }
    marker("unassigned-header");
    marker("unassigned-placeholder");
    projected.push(...(groups.get("unassigned") ?? []));

    const result = items.map(() => hidden);
    let top = rects[0].top;
    for (const item of projected) {
      const index = indices.get(rosterListItemId(item));
      const rect = index === undefined ? undefined : rects[index];
      if (index !== undefined && rect) result[index] = { ...stationary, y: top - rect.top };
      const movedEntry =
        item.kind === "entry" && rosterListItemId(item) === rosterListItemId(active);
      const height =
        item.kind === "marker" && markerIsPinnedBoundary(item.marker)
          ? labelHeight
          : item.kind === "marker" &&
              (item.marker === "unassigned-placeholder" ||
                (typeof item.marker === "object" && item.marker.kind === "section-placeholder"))
            ? (groups.get(typeof item.marker === "object" ? item.marker.sectionId : "unassigned")
                ?.length ?? 0) === 0
              ? slimHeight
              : 0
            : item.kind === "marker"
              ? (rect?.height ?? headerHeight)
              : movedEntry
                ? cardHeight
                : (rect?.height ?? cardHeight);
      top += height + 1;
    }
    result[activeIndex] = stationary;
    return result;
  }

  function projectSectionReorder({
    rects,
    activeIndex,
    overIndex,
    sectionId,
  }: Layout & { sectionId: string }) {
    const overId = rosterListItemId(items[overIndex] ?? items[activeIndex]!);
    const overSectionId =
      parseRosterSectionHeaderId(overId) ??
      (overId === rosterMarkerId("unassigned-header") ? "__end__" : null);
    if (overSectionId === null) return [];
    const blocks: RosterListItem[][] = [];
    let current: RosterListItem[] = [];
    const flush = () => {
      if (current.length > 0) blocks.push(current);
      current = [];
    };
    for (const item of items) {
      if (
        item.kind === "marker" &&
        (item.marker === "pinned-header" ||
          item.marker === "pinned-divider" ||
          (typeof item.marker === "object" && item.marker.kind === "section-header") ||
          item.marker === "unassigned-header")
      ) {
        if (
          typeof item.marker === "object" &&
          item.marker.kind === "section-header" &&
          current.length > 0
        ) {
          flush();
        }
      }
      current.push(item);
    }
    flush();
    const pinnedBlocks = blocks.filter((block) =>
      block.some(
        (item) =>
          item.kind === "marker" &&
          (item.marker === "pinned-header" || item.marker === "pinned-divider"),
      ),
    );
    const sectionBlocks = blocks.filter((block) =>
      block.some(
        (item) =>
          item.kind === "marker" &&
          typeof item.marker === "object" &&
          item.marker.kind === "section-header",
      ),
    );
    const restBlocks = blocks.filter(
      (block) => !pinnedBlocks.includes(block) && !sectionBlocks.includes(block),
    );
    const from = sectionBlocks.findIndex((block) =>
      block.some(
        (item) =>
          item.kind === "marker" &&
          typeof item.marker === "object" &&
          item.marker.kind === "section-header" &&
          item.marker.sectionId === sectionId,
      ),
    );
    if (from === -1) return [];
    const [moved] = sectionBlocks.splice(from, 1);
    if (!moved) return [];
    const to =
      overSectionId === "__end__"
        ? sectionBlocks.length
        : sectionBlocks.findIndex((block) =>
            block.some(
              (item) =>
                item.kind === "marker" &&
                typeof item.marker === "object" &&
                item.marker.kind === "section-header" &&
                item.marker.sectionId === overSectionId,
            ),
          );
    sectionBlocks.splice(to < 0 ? sectionBlocks.length : to, 0, moved);
    const projected = [...pinnedBlocks.flat(), ...sectionBlocks.flat(), ...restBlocks.flat()];
    const result = items.map(() => hidden);
    let top = rects[0]?.top ?? 0;
    for (const item of projected) {
      const index = indices.get(rosterListItemId(item));
      const rect = index === undefined ? undefined : rects[index];
      if (index !== undefined && rect) result[index] = { ...stationary, y: top - rect.top };
      top += (rect?.height ?? 0) + 1;
    }
    result[activeIndex] = stationary;
    return result;
  }

  return (args) => {
    if (
      previous?.rects !== args.rects ||
      previous.activeIndex !== args.activeIndex ||
      previous.overIndex !== args.overIndex
    ) {
      previous = args;
      transforms = project(args);
    }
    return transforms === null
      ? verticalListSortingStrategy(args)
      : (transforms[args.index] ?? stationary);
  };
}

export function isRosterEntryDrag(id: string): boolean {
  return parseRosterEntryId(id) !== null;
}
