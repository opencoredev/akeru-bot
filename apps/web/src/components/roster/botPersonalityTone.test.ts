// @effect-diagnostics nodeBuiltinImport:off - The band contract reads its source.
import * as NodeFS from "node:fs";

import { BALANCED_BOT_PERSONALITY_TONE } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  BOT_PERSONALITY_TONE_OPTIONS,
  botPersonalityToneLabel,
  canonicalizeBotPersonalityTone,
  normalizeBotPersonalityTone,
  resolveBotPersonalityToneBand,
  resolveBotPersonalityToneOption,
} from "./botPersonalityTone";

describe("botPersonalityTone", () => {
  it("defines the three choices shown in settings", () => {
    expect(BOT_PERSONALITY_TONE_OPTIONS.map((stop) => stop.label)).toEqual([
      "Chill",
      "Balanced",
      "Professional",
    ]);
    expect(BOT_PERSONALITY_TONE_OPTIONS.map((stop) => stop.value)).toEqual([0, 50, 100]);
  });

  it("splits bands on the same thresholds the server instructions use", () => {
    expect(resolveBotPersonalityToneBand(0).id).toBe("chill");
    expect(resolveBotPersonalityToneBand(20).id).toBe("chill");
    expect(resolveBotPersonalityToneBand(21).id).toBe("relaxed");
    expect(resolveBotPersonalityToneBand(44).id).toBe("relaxed");
    expect(resolveBotPersonalityToneBand(45).id).toBe("balanced");
    expect(resolveBotPersonalityToneBand(55).id).toBe("balanced");
    expect(resolveBotPersonalityToneBand(56).id).toBe("composed");
    expect(resolveBotPersonalityToneBand(79).id).toBe("composed");
    expect(resolveBotPersonalityToneBand(80).id).toBe("professional");
    expect(resolveBotPersonalityToneBand(100).id).toBe("professional");
  });

  it("gives every band a distinct sample so the preview actually changes", () => {
    const samples = [0, 30, 50, 70, 100].map((tone) => resolveBotPersonalityToneBand(tone).sample);
    expect(new Set(samples).size).toBe(samples.length);
    // The instructions forbid dashes, so the illustration must not promise them.
    for (const sample of samples) {
      expect(sample).not.toMatch(/[—–]/);
    }
  });

  it("falls back to balanced when the bot predates the field", () => {
    expect(normalizeBotPersonalityTone(undefined)).toBe(BALANCED_BOT_PERSONALITY_TONE);
    expect(normalizeBotPersonalityTone(null)).toBe(BALANCED_BOT_PERSONALITY_TONE);
    expect(normalizeBotPersonalityTone(Number.NaN)).toBe(BALANCED_BOT_PERSONALITY_TONE);
    expect(botPersonalityToneLabel(BALANCED_BOT_PERSONALITY_TONE)).toBe("Balanced");
  });

  it("maps the five internal bands to the three visible choices", () => {
    expect(resolveBotPersonalityToneOption(20).label).toBe("Chill");
    expect(resolveBotPersonalityToneOption(44).label).toBe("Chill");
    expect(resolveBotPersonalityToneOption(50).label).toBe("Balanced");
    expect(resolveBotPersonalityToneOption(56).label).toBe("Professional");
    expect(resolveBotPersonalityToneOption(100).label).toBe("Professional");
    expect(canonicalizeBotPersonalityTone(35)).toBe(0);
    expect(canonicalizeBotPersonalityTone(75)).toBe(100);
  });

  it("clamps and rounds anything outside the persisted range", () => {
    expect(normalizeBotPersonalityTone(-10)).toBe(0);
    expect(normalizeBotPersonalityTone(140)).toBe(100);
    expect(normalizeBotPersonalityTone(62.4)).toBe(62);
    expect(normalizeBotPersonalityTone(62.5)).toBe(63);
  });

  it("keeps its band thresholds aligned with the server instructions", () => {
    const serverSource = NodeFS.readFileSync(
      new URL("../../../../../apps/server/src/provider/AkeruAgentInstructions.ts", import.meta.url),
      "utf8",
    );
    // If these move on the server, the settings copy is lying about behavior.
    expect(serverSource).toContain("tone <= 20");
    expect(serverSource).toContain("tone < 45");
    expect(serverSource).toContain("tone <= 55");
    expect(serverSource).toContain("tone < 80");
  });
});
