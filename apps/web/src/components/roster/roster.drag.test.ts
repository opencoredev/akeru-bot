import { describe, expect, it } from "vite-plus/test";
import { closestCenter, type CollisionDetection } from "@dnd-kit/core";
import { verticalListSortingStrategy, type SortingStrategy } from "@dnd-kit/sortable";

import { createRosterCollisionDetection, createRosterSortingStrategy } from "./roster.drag";
import {
  buildRosterListItems,
  rosterEntryId,
  rosterListItemId,
  rosterMarkerId,
  type RosterItemRef,
  type RosterListItem,
} from "./roster.logic";

const stationary = { x: 0, y: 0, scaleX: 1, scaleY: 1 };
const akeru: RosterItemRef = { kind: "bot", id: "akeru" };
const mori: RosterItemRef = { kind: "bot", id: "mori" };

function layout(items: readonly RosterListItem[], active: string, over: string, cardHeight = 52) {
  let top = 100;
  const rects = items.map((item) => {
    const height =
      item.kind === "entry"
        ? cardHeight
        : item.marker === "pinned-header" || item.marker === "pinned-divider"
          ? 0
          : item.marker === "unassigned-placeholder" ||
              (typeof item.marker === "object" && item.marker.kind === "section-placeholder")
            ? 0
            : 32;
    const rect = { top, height, bottom: top + height, left: 0, right: 260, width: 260 };
    top += height + 1;
    return rect;
  });
  const activeIndex = items.findIndex((item) => rosterListItemId(item) === active);
  return {
    activeIndex,
    overIndex: items.findIndex((item) => rosterListItemId(item) === over),
    activeNodeRect: rects[activeIndex]!,
    rects,
    index: 0,
  } satisfies Parameters<SortingStrategy>[0];
}

describe("roster collision detection", () => {
  const items = buildRosterListItems({
    pinnedItems: [],
    sections: [],
    unassignedItems: [akeru, mori],
  });

  function collisionArgs() {
    const { rects, activeIndex, overIndex } = layout(
      items,
      rosterEntryId(akeru),
      rosterEntryId(mori),
    );
    const collisionRect = rects[overIndex]!;
    return {
      active: {
        id: rosterEntryId(akeru),
        data: { current: {} },
        rect: { current: { initial: rects[activeIndex]!, translated: collisionRect } },
      },
      collisionRect,
      droppableRects: new Map(items.map((item, index) => [rosterListItemId(item), rects[index]!])),
      droppableContainers: items.map((item, index) => ({
        id: rosterListItemId(item),
        key: rosterListItemId(item),
        disabled: false,
        data: { current: {} },
        node: { current: null },
        rect: { current: rects[index]! },
      })),
      pointerCoordinates: null,
    } satisfies Parameters<CollisionDetection>[0];
  }

  it("rejects an unsupported neighbor instead of selecting another section", () => {
    const args = collisionArgs();
    const detector = createRosterCollisionDetection((id) => id !== rosterEntryId(mori));
    expect(closestCenter(args)[0]?.id).toBe(rosterEntryId(mori));
    expect(detector(args).map((collision) => collision.id)).toEqual([rosterEntryId(akeru)]);
  });

  it("selects the nearest supported target", () => {
    const detector = createRosterCollisionDetection(() => true);
    expect(detector(collisionArgs())[0]?.id).toBe(rosterEntryId(mori));
  });
});

describe("roster drag projection", () => {
  it("opens Pins label space while dragging an unassigned bot to the header", () => {
    const items = buildRosterListItems({
      pinnedItems: [],
      sections: [],
      unassignedItems: [akeru, mori],
    });
    const strategy = createRosterSortingStrategy({
      items,
      boundaryLabelHeight: 16,
    });
    const args = layout(items, rosterEntryId(akeru), rosterMarkerId("pinned-header"));
    const header = strategy({ ...args, index: 0 });
    expect(header).toEqual(stationary);
    const akeruIndex = items.findIndex((item) => rosterListItemId(item) === rosterEntryId(akeru));
    expect(strategy({ ...args, index: akeruIndex })).toEqual(stationary);
  });

  it("keeps same-section reorder on the default vertical strategy", () => {
    const items = buildRosterListItems({
      pinnedItems: [],
      sections: [],
      unassignedItems: [akeru, mori],
    });
    const strategy = createRosterSortingStrategy({ items });
    const args = layout(items, rosterEntryId(akeru), rosterEntryId(mori));
    for (let index = 0; index < items.length; index += 1) {
      if (index === args.activeIndex) continue;
      expect(strategy({ ...args, index })).toEqual(verticalListSortingStrategy({ ...args, index }));
    }
  });
});
