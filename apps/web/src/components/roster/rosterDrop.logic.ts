import { Predicate } from "effect";

const BOT_DRAG_PREFIX = "bot:";

const GROUP_DROP_PREFIX = "group:";

const ROSTER_MARKER_PREFIX = "roster-marker-";

export type RosterItemRef = { kind: "bot"; id: string } | { kind: "group"; id: string };

export function rosterItemKey(item: RosterItemRef): string {
  return `${item.kind}:${item.id}`;
}

export function rosterItemsEqual(left: RosterItemRef, right: RosterItemRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}

/** Shift an item by one slot in a visible zone. Null when it cannot move. */
export function moveRosterItemInOrder(
  order: readonly RosterItemRef[],
  item: RosterItemRef,
  delta: -1 | 1,
): RosterItemRef[] | null {
  const index = order.findIndex((candidate) => rosterItemsEqual(candidate, item));
  const destination = index + delta;

  if (index < 0 || destination < 0 || destination >= order.length) return null;
  const next = [...order];
  const [moved] = next.splice(index, 1);

  if (!moved) return null;
  next.splice(destination, 0, moved);

  return next;
}

export function rosterBotDragId(botId: string): string {
  return `${BOT_DRAG_PREFIX}${botId}`;
}

export function rosterGroupDropId(groupId: string): string {
  return `${GROUP_DROP_PREFIX}${groupId}`;
}

export function parseRosterBotDragId(id: string): string | null {
  return id.startsWith(BOT_DRAG_PREFIX) ? id.slice(BOT_DRAG_PREFIX.length) || null : null;
}

export function parseRosterGroupDropId(id: string): string | null {
  return id.startsWith(GROUP_DROP_PREFIX) ? id.slice(GROUP_DROP_PREFIX.length) || null : null;
}

export function rosterEntryId(item: RosterItemRef): string {
  return item.kind === "bot" ? rosterBotDragId(item.id) : rosterGroupDropId(item.id);
}

export function parseRosterEntryId(id: string): RosterItemRef | null {
  const botId = parseRosterBotDragId(id);

  if (botId) return { kind: "bot", id: botId };
  const groupId = parseRosterGroupDropId(id);

  if (groupId) return { kind: "group", id: groupId };

  return null;
}

/** Reconstruct mixed section order from the persisted group-then-bot arrays. */
export function rosterSectionItems(section: {
  readonly botIds: readonly string[];
  readonly groupIds?: readonly string[];
  readonly items?: readonly RosterItemRef[] | undefined;
}): RosterItemRef[] {
  if (section.items && section.items.length > 0) return [...section.items];

  return [
    ...(section.groupIds ?? []).map((id) => ({ kind: "group" as const, id })),
    ...section.botIds.map((id) => ({ kind: "bot" as const, id })),
  ];
}

export function splitRosterSectionItems(items: readonly RosterItemRef[]) {
  return {
    botIds: items.flatMap((item) => (item.kind === "bot" ? [item.id] : [])),
    groupIds: items.flatMap((item) => (item.kind === "group" ? [item.id] : [])),
  };
}

export type RosterZone = "pinned" | "unassigned" | { readonly sectionId: string };

export function rosterItemsForZone(
  zone: RosterZone,
  layout: {
    readonly pinnedItems: readonly RosterItemRef[];
    readonly sections: readonly { readonly id: string; readonly items: readonly RosterItemRef[] }[];
    readonly unassignedItems: readonly RosterItemRef[];
  },
): readonly RosterItemRef[] {
  if (zone === "pinned") return layout.pinnedItems;

  if (zone === "unassigned") return layout.unassignedItems;

  return layout.sections.find((section) => section.id === zone.sectionId)?.items ?? [];
}

export function rosterZoneId(zone: RosterZone): string {
  return zone === "pinned" || zone === "unassigned" ? zone : zone.sectionId;
}

export function rosterZonesEqual(left: RosterZone, right: RosterZone): boolean {
  if (left === "pinned" || left === "unassigned") return left === right;

  return Predicate.isObjectOrArray(right) && left.sectionId === right.sectionId;
}

export type RosterListMarker =
  | "pinned-header"
  | "pinned-divider"
  | "unassigned-header"
  | "unassigned-placeholder"
  | { readonly kind: "section-header"; readonly sectionId: string }
  | { readonly kind: "section-placeholder"; readonly sectionId: string };

export function rosterMarkerId(marker: RosterListMarker): string {
  if (Predicate.isString(marker)) return `${ROSTER_MARKER_PREFIX}${marker}`;

  return `${ROSTER_MARKER_PREFIX}${marker.kind}-${marker.sectionId}`;
}

export function parseRosterSectionHeaderId(id: string): string | null {
  const prefix = `${ROSTER_MARKER_PREFIX}section-header-`;

  return id.startsWith(prefix) ? id.slice(prefix.length) || null : null;
}

export type RosterListItem =
  | { readonly kind: "entry"; readonly item: RosterItemRef; readonly zone: RosterZone }
  | { readonly kind: "marker"; readonly marker: RosterListMarker };

export function rosterListItemId(item: RosterListItem): string {
  return item.kind === "entry" ? rosterEntryId(item.item) : rosterMarkerId(item.marker);
}

export type RosterLayoutSection = {
  readonly id: string;
  readonly name: string;
  readonly items: readonly RosterItemRef[];
  readonly collapsed: boolean;
};

export function buildRosterListItems(input: {
  readonly pinnedItems: readonly RosterItemRef[];
  readonly sections: readonly RosterLayoutSection[];
  readonly unassignedItems: readonly RosterItemRef[];
}): RosterListItem[] {
  const items: RosterListItem[] = [{ kind: "marker", marker: "pinned-header" }];

  for (const item of input.pinnedItems) {
    items.push({ kind: "entry", item, zone: "pinned" });
  }

  items.push({ kind: "marker", marker: "pinned-divider" });

  for (const section of input.sections) {
    const zone = { sectionId: section.id };
    items.push({ kind: "marker", marker: { kind: "section-header", sectionId: section.id } });
    items.push({ kind: "marker", marker: { kind: "section-placeholder", sectionId: section.id } });

    if (!section.collapsed) {
      for (const item of section.items) {
        items.push({ kind: "entry", item, zone });
      }
    }
  }

  items.push({ kind: "marker", marker: "unassigned-header" });
  items.push({ kind: "marker", marker: "unassigned-placeholder" });

  for (const item of input.unassignedItems) {
    items.push({ kind: "entry", item, zone: "unassigned" });
  }

  return items;
}

function markerZone(marker: RosterListMarker, firstSectionId: string | null): RosterZone | null {
  if (marker === "pinned-header") return "pinned";

  if (marker === "pinned-divider")
    return firstSectionId ? { sectionId: firstSectionId } : "unassigned";

  if (marker === "unassigned-header" || marker === "unassigned-placeholder") return "unassigned";

  return { sectionId: marker.sectionId };
}

function zoneAtRosterSlot(
  items: readonly RosterListItem[],
  index: number,
  firstSectionId: string | null,
): RosterZone {
  let zone: RosterZone = "pinned";

  for (let i = 0; i < index && i < items.length; i += 1) {
    const item = items[i]!;

    if (item.kind !== "marker") continue;
    const next = markerZone(item.marker, firstSectionId);

    if (next) zone = next;

    if (!Predicate.isString(item.marker) && item.marker.kind === "section-header") {
      zone = { sectionId: item.marker.sectionId };
    }

    if (item.marker === "unassigned-header") zone = "unassigned";

    if (item.marker === "pinned-divider") {
      zone = firstSectionId ? { sectionId: firstSectionId } : "unassigned";
    }
  }

  return zone;
}

function zoneForOverItem(
  over: RosterListItem,
  moved: readonly RosterListItem[],
  overIndex: number,
  firstSectionId: string | null,
): RosterZone {
  if (over.kind === "entry") return over.zone;

  if (over.marker === "pinned-header") return "pinned";

  if (over.marker === "unassigned-header" || over.marker === "unassigned-placeholder") {
    return "unassigned";
  }

  if (!Predicate.isString(over.marker)) return { sectionId: over.marker.sectionId };

  return zoneAtRosterSlot(moved, overIndex, firstSectionId);
}

export type RosterDropTarget = {
  readonly zone: RosterZone;
  readonly order: readonly RosterItemRef[];
};

function collectZoneOrder(items: readonly RosterListItem[], zone: RosterZone): RosterItemRef[] {
  return items.flatMap((item) =>
    item.kind === "entry" && rosterZonesEqual(item.zone, zone) ? [item.item] : [],
  );
}

export function resolveRosterDropTarget(
  items: readonly RosterListItem[],
  activeId: string,
  overId: string,
  firstSectionId: string | null,
): RosterDropTarget | null {
  const activeIndex = items.findIndex((item) => rosterListItemId(item) === activeId);
  const overIndex = items.findIndex((item) => rosterListItemId(item) === overId);
  const active = activeIndex === -1 ? undefined : items[activeIndex];
  const over = overIndex === -1 ? undefined : items[overIndex];

  if (!active || !over || active.kind !== "entry") return null;
  const moved = items.filter((_, index) => index !== activeIndex);
  moved.splice(overIndex, 0, active);
  const zone = zoneForOverItem(over, moved, overIndex, firstSectionId);

  return {
    zone,
    order: collectZoneOrder(
      moved.map((item) =>
        item.kind === "entry" && rosterItemsEqual(item.item, active.item)
          ? { ...item, zone }
          : item,
      ),
      zone,
    ),
  };
}

export type RosterDropPlan =
  | { readonly kind: "none" }
  | { readonly kind: "reorder-pinned"; readonly order: readonly RosterItemRef[] }
  | { readonly kind: "pin"; readonly item: RosterItemRef; readonly order: readonly RosterItemRef[] }
  | {
      readonly kind: "move";
      readonly item: RosterItemRef;
      readonly zone: Exclude<RosterZone, "pinned">;
      readonly order: readonly RosterItemRef[];
      readonly unpin: boolean;
    }
  | { readonly kind: "reorder-section"; readonly fromIndex: number; readonly toIndex: number };

function sameOrder(left: readonly RosterItemRef[], right: readonly RosterItemRef[]): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => rosterItemsEqual(item, right[index]!))
  );
}

export function planRosterDrop(input: {
  readonly activeId: string;
  readonly from: RosterZone;
  readonly target: RosterDropTarget;
  readonly pinnedOrder: readonly RosterItemRef[];
}): RosterDropPlan {
  const item = parseRosterEntryId(input.activeId);

  if (!item) return { kind: "none" };

  if (input.target.zone === "pinned") {
    if (input.from === "pinned" && sameOrder(input.target.order, input.pinnedOrder)) {
      return { kind: "none" };
    }

    if (input.from === "pinned") {
      return { kind: "reorder-pinned", order: input.target.order };
    }

    return { kind: "pin", item, order: input.target.order };
  }

  return {
    kind: "move",
    item,
    zone: input.target.zone,
    order: input.target.order,
    unpin: input.from === "pinned",
  };
}

export function planRosterSectionDrop(input: {
  readonly sectionIds: readonly string[];
  readonly activeSectionId: string;
  readonly overId: string;
}): RosterDropPlan {
  const fromIndex = input.sectionIds.indexOf(input.activeSectionId);

  if (fromIndex === -1) return { kind: "none" };
  const overSectionId = parseRosterSectionHeaderId(input.overId);
  let toIndex: number;

  if (overSectionId) {
    toIndex = input.sectionIds.indexOf(overSectionId);
  } else if (input.overId === rosterMarkerId("unassigned-header")) {
    toIndex = input.sectionIds.length - 1;
  } else {
    return { kind: "none" };
  }

  if (toIndex === -1 || toIndex === fromIndex) return { kind: "none" };

  return { kind: "reorder-section", fromIndex, toIndex };
}

export function rosterZoneHasVisibleEntries(
  items: readonly RosterListItem[],
  zone: RosterZone,
  except?: RosterItemRef,
): boolean {
  return items.some(
    (item) =>
      item.kind === "entry" &&
      rosterZonesEqual(item.zone, zone) &&
      (except === undefined || !rosterItemsEqual(item.item, except)),
  );
}
