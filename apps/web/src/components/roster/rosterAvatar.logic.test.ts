import { describe, expect, it } from "vite-plus/test";

import {
  botAvatarSeed,
  DEFAULT_BLOB_COLOR,
  DEFAULT_BLOB_SHAPE,
  randomBotAvatar,
  resolveBlobRendering,
  resolveBlobColor,
  resolveBlobEyes,
  resolveBlobOutline,
  BLOB_COLORS,
  BLOB_SHAPES,
} from "./rosterAvatar.logic";

describe("resolveBlobEyes", () => {
  it("cuts eyes out of every preset", () => {
    for (const color of BLOB_COLORS) {
      expect(resolveBlobEyes(color)).toEqual({ kind: "cutout" });
    }
  });

  it("paints eyes on bodies too light or too dark for a cutout to read", () => {
    expect(resolveBlobEyes("#FFFFFF")).toEqual({ kind: "ink", ink: "#161616" });
    expect(resolveBlobEyes("#FFF4B0")).toEqual({ kind: "ink", ink: "#161616" });
    expect(resolveBlobEyes("#000000")).toEqual({ kind: "ink", ink: "#FFFFFF" });
  });
});

describe("resolveBlobColor", () => {
  it("moves retired muted presets onto the vivid palette", () => {
    expect(resolveBlobColor("#E0645C")).toBe("#FF4A5A");
    expect(resolveBlobColor("#7a8699")).toBe("#8E8E93");
  });

  it("keeps custom colors and falls back for invalid ones", () => {
    expect(resolveBlobColor("#123abc")).toBe("#123ABC");
    expect(resolveBlobColor("#FFFFFF")).toBe("#FFFFFF");
    expect(resolveBlobColor("")).toBe(DEFAULT_BLOB_COLOR);
    expect(resolveBlobColor("red")).toBe(DEFAULT_BLOB_COLOR);
  });
});

describe("resolveBlobOutline", () => {
  it("outlines only bodies light enough to fade into a light surface", () => {
    expect(resolveBlobOutline("#FFFFFF")).not.toBeNull();

    for (const color of [...BLOB_COLORS, "#000000", "nope"]) {
      expect(resolveBlobOutline(color)).toBeNull();
    }
  });
});

describe("randomBotAvatar", () => {
  it("returns a valid blob from the presets", () => {
    for (let i = 0; i < 20; i++) {
      const avatar = randomBotAvatar(() => i / 20);
      expect(avatar.kind).toBe("blob");

      if (avatar.kind !== "blob") continue;
      expect(BLOB_SHAPES).toContain(avatar.shape);
      expect(BLOB_COLORS).toContain(avatar.color);
    }
  });

  it("is deterministic for an injected random source", () => {
    expect(randomBotAvatar(() => 0)).toEqual(randomBotAvatar(() => 0));
  });
});

describe("resolveBlobRendering", () => {
  it("passes a valid blob avatar through", () => {
    expect(resolveBlobRendering({ kind: "blob", shape: "hex", color: "#16C47A" })).toEqual({
      shape: "hex",
      color: "#16C47A",
    });
  });

  it("draws legacy dither avatars as a stable blob picked from the seed", () => {
    const first = resolveBlobRendering({ kind: "dither", seed: "bot-a" });
    expect(resolveBlobRendering({ kind: "dither", seed: "bot-a" })).toEqual(first);
    expect(BLOB_SHAPES).toContain(first.shape);
    expect(BLOB_COLORS).toContain(first.color);

    const looks = new Set(
      ["bot-a", "bot-b", "bot-c", "bot-d", "bot-e"].map((seed) =>
        JSON.stringify(resolveBlobRendering({ kind: "dither", seed })),
      ),
    );

    expect(looks.size).toBeGreaterThan(1);
  });

  it("falls back to the default blob for images and missing avatars", () => {
    expect(resolveBlobRendering({ kind: "image", assetPath: "/a.png", dithered: false })).toEqual({
      shape: DEFAULT_BLOB_SHAPE,
      color: DEFAULT_BLOB_COLOR,
    });
    expect(resolveBlobRendering(null)).toEqual({
      shape: DEFAULT_BLOB_SHAPE,
      color: DEFAULT_BLOB_COLOR,
    });
  });

  it("falls back for an unknown shape or empty color from persisted data", () => {
    const persisted = { kind: "blob" as const, shape: "starburst", color: "" };
    expect(resolveBlobRendering(persisted)).toEqual({
      shape: DEFAULT_BLOB_SHAPE,
      color: DEFAULT_BLOB_COLOR,
    });
  });

  it("falls back for a retired shape name", () => {
    const persisted = { kind: "blob" as const, shape: "pebble", color: "#FFFFFF" };
    expect(resolveBlobRendering(persisted)).toEqual({
      shape: DEFAULT_BLOB_SHAPE,
      color: "#FFFFFF",
    });
  });
});

describe("botAvatarSeed", () => {
  it("is a stable seed between 0 and 1", () => {
    expect(botAvatarSeed("Akeru")).toBe(botAvatarSeed("Akeru"));
    expect(botAvatarSeed("Akeru")).toBeGreaterThanOrEqual(0);
    expect(botAvatarSeed("Akeru")).toBeLessThan(1);
  });

  it("staggers different bots", () => {
    expect(botAvatarSeed("Akeru")).not.toBe(botAvatarSeed("Mori"));
  });
});
