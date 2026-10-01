import { assert, describe, it } from "@effect/vitest";

import { selectMarqueeElements } from "./MarqueeSelection.ts";

describe("marquee selection", () => {
  it("skips geometry for ineligible large-DOM containers and preserves stable area order", () => {
    const elements = Array.from({ length: 10000 }, (_, index) => ({
      index,
      eligible: index % 100 === 0,
      width: 2 + (index % 7),
    }));

    let measurements = 0;

    const selected = selectMarqueeElements({
      elements,
      rect: { x: 0, y: 0, width: 100, height: 100 },
      limit: 20,
      eligible: (element) => element.eligible,
      measure: (element) => {
        measurements += 1;

        return {
          left: 0,
          top: 0,
          right: element.width,
          bottom: 2,
          width: element.width,
          height: 2,
        };
      },
    });

    assert.equal(measurements, 100);
    assert.deepEqual(
      selected,
      elements
        .filter((element) => element.eligible)
        .sort((left, right) => left.width - right.width)
        .slice(0, 20),
    );
  });

  it("keeps edge centers, excludes small bounds and rejects off-center intersections", () => {
    const elements = [
      { left: -2, top: 0, right: 2, bottom: 2, width: 4, height: 2 },
      { left: -4, top: 0, right: 2, bottom: 2, width: 6, height: 2 },
      { left: 0, top: 0, right: 1, bottom: 2, width: 1, height: 2 },
      { left: 9, top: 0, right: 11, bottom: 2, width: 2, height: 2 },
      { left: 11, top: 0, right: 13, bottom: 2, width: 2, height: 2 },
    ];

    assert.deepEqual(
      selectMarqueeElements({
        elements,
        rect: { x: 0, y: 0, width: 10, height: 10 },
        limit: 20,
        eligible: () => true,
        measure: (element) => element,
      }),
      [elements[3], elements[0]],
    );
  });
});
