import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createRosterListMotion } from "./roster.motion";

class TestAnimation {
  progress: number | null = 0;
  playState: AnimationPlayState = "running";
  effect = { getComputedTiming: () => ({ progress: this.progress }) };
  cancel = vi.fn(() => {
    this.playState = "idle";
  });
  private onFinish: (() => void) | undefined;
  addEventListener(_type: string, listener: () => void) {
    this.onFinish = listener;
  }
  finish() {
    this.playState = "finished";
    this.onFinish?.();
  }
}

class TestRow {
  offsetTop = 0;
  offsetLeft = 4;
  offsetWidth = 260;
  namespaceURI = "http://www.w3.org/1999/xhtml";
  dragTranslate = 0;
  style: Record<string, string> = {};
  inert = false;
  attributes: { name: string; value: string }[] = [];
  children: TestRow[] = [];
  clones: TestRow[] = [];
  remove = vi.fn();
  animations: TestAnimation[] = [];
  constructor(
    readonly name: string,
    public offsetHeight = 82,
  ) {}
  getBoundingClientRect() {
    return { top: this.offsetTop + this.dragTranslate, height: this.offsetHeight };
  }
  setAttribute(name: string, value: string) {
    this.removeAttribute(name);
    this.attributes.push({ name, value });
  }
  removeAttribute(name: string) {
    this.attributes = this.attributes.filter((attribute) => attribute.name !== name);
  }
  querySelectorAll(_selector: string): TestRow[] {
    return this.children.flatMap((child) => [child, ...child.querySelectorAll("*")]);
  }
  cloneNode(_deep: boolean): TestRow {
    const clone = new TestRow(`${this.name} clone`, this.offsetHeight);
    clone.namespaceURI = this.namespaceURI;
    clone.style = { ...this.style };
    clone.attributes = this.attributes.map((attribute) => ({ ...attribute }));
    clone.children = this.children.map((child) => child.cloneNode(true));
    this.clones.push(clone);
    return clone;
  }
  animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => {
    const animation = new TestAnimation();
    this.animations.push(animation);
    return animation;
  });
}

function fixture(rows: TestRow[]) {
  const media = { matches: false };
  const parent = {
    children: rows,
    ownerDocument: { defaultView: { matchMedia: () => media } },
    getBoundingClientRect: () => ({ top: 0 }),
    append(node: TestRow) {
      parent.children.push(node);
      node.remove.mockImplementation(() => {
        parent.children = parent.children.filter((child) => child !== node);
      });
    },
  };
  function layout(next: TestRow[]) {
    let top = 8;
    for (const row of next) {
      row.offsetTop = top;
      top += row.offsetHeight + 1;
    }
    parent.children = [
      ...next,
      ...parent.children.filter((row) => row.style.position === "absolute"),
    ];
  }
  layout(rows);
  const motion = createRosterListMotion(parent as unknown as HTMLUListElement);
  return { motion, layout, media, parent };
}

function expectMove(row: TestRow, offset: number) {
  expect(row.animate).toHaveBeenLastCalledWith(
    [{ transform: `translateY(${offset}px)` }, { transform: "translateY(0px)" }],
    { duration: 150, easing: "ease-out" },
  );
}

beforeEach(() => vi.stubGlobal("HTMLElement", TestRow));
afterEach(() => vi.unstubAllGlobals());

describe("roster list motion", () => {
  it("glides every row from its released position into its committed slot", () => {
    const [a, b, c] = [new TestRow("a"), new TestRow("b"), new TestRow("c")];
    const { motion, layout } = fixture([a, b, c]);
    motion.update(true);
    motion.suspend();
    a.dragTranslate = 130;
    b.dragTranslate = -83;
    c.dragTranslate = 16;
    motion.update(false);
    motion.release();
    layout([b, a, c]);
    a.dragTranslate = b.dragTranslate = c.dragTranslate = 0;
    motion.update(true);
    expectMove(a, 47);
    expect(b.animations).toHaveLength(0);
    expectMove(c, 16);
  });

  it("does not glide on release when motion is reduced", () => {
    const [a, b] = [new TestRow("a"), new TestRow("b")];
    const { motion, layout, media } = fixture([a, b]);
    motion.update(true);
    media.matches = true;
    a.dragTranslate = 100;
    motion.release();
    layout([b, a]);
    a.dragTranslate = 0;
    motion.update(true);
    expect(a.animations).toHaveLength(0);
    expect(b.animations).toHaveLength(0);
  });

  it("does not replay sortable transforms after a cancelled drag", () => {
    const a = new TestRow("a");
    const b = new TestRow("b");
    const { motion, layout } = fixture([a, b]);
    motion.update(true);
    motion.suspend();
    a.dragTranslate = 200;
    b.dragTranslate = -83;
    motion.update(false);
    motion.suspend();
    a.dragTranslate = b.dragTranslate = 0;
    layout([b, a]);
    motion.update(true);
    expect(a.animations).toHaveLength(0);
    expect(b.animations).toHaveLength(0);
  });
});
