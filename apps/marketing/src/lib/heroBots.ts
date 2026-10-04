import type { BotBlobShape } from "./botAvatarShapes";

/** The demo bots shown across the home page and blog covers. They match the bots in the hero screenshot. */
export interface HeroBot {
  name: string;
  shape: BotBlobShape;
  color: string;
}

export const HERO_BOTS: HeroBot[] = [
  { name: "Scout", shape: "squircle", color: "#2E8EFF" },
  { name: "Relay", shape: "hex", color: "#16C47A" },
  { name: "Mira", shape: "drop", color: "#FF4FA8" },
  { name: "Atlas", shape: "cloud", color: "#FFA826" },
  { name: "Ember", shape: "triangle", color: "#FF7A1F" },
];
