import type { McpServerId } from "@t3tools/contracts";

/**
 * Local mirror of the bot roster wire shape the server-side persistence work
 * is building in parallel. Field-for-field identical so integration becomes a
 * type-import swap to `@t3tools/contracts`; do not diverge from that shape
 * here.
 */

export type BotBlobShape =
  | "circle"
  | "squircle"
  | "square"
  | "pill"
  | "triangle"
  | "hex"
  | "cloud"
  | "drop";

export type BotAvatar =
  | { kind: "blob"; shape: BotBlobShape; color: string }
  | { kind: "dither"; seed: string }
  | { kind: "image"; assetPath: string; dithered: boolean };

export interface Bot {
  id: string;
  name: string;
  title: string;
  label: string | null;
  description: string | null;
  disabledMcpServerIds: readonly McpServerId[];
  avatar: BotAvatar;
  engine: { provider: string; model: string } | null;
  sandbox: "local" | "e2b" | "daytona" | "vercel" | "upstash" | null;
  runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  usageCap: { unit: "tokens"; limit: number } | null;
  voiceEnabled: boolean;
  groupId: string | null;
  pinned: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Group {
  id: string;
  name: string;
  bossBotId: string | null;
  members: ReadonlyArray<{ botId: string; role: "boss" | "specialist" }>;
  createdAt: string;
  updatedAt: string;
}
