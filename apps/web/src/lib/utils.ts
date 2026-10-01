import { CommandId, MessageId, ProjectId, ThreadId } from "@akeru/contracts";
import * as Encoding from "effect/Encoding";
import { DraftId } from "../composerDraftStore";

import type { CnFunction } from "cn";
import { createCn } from "cn/config";

/**
 * Class merger that knows the extra theme steps declared in index.css, so a
 * later `text-11px` replaces an earlier `text-xs` instead of being read as a
 * text color.
 */
export const cn: CnFunction = createCn({
  extend: {
    theme: {
      text: ["7px", "8px", "9px", "10px", "11px", "12px", "13px", "15px", "17px", "26px"],
      tracking: [
        "caps",
        "caps-wide",
        "caps-wider",
        "caps-widest",
        "title-xs",
        "title-sm",
        "title",
        "title-lg",
      ],
      leading: ["copy", "copy-tight"],
    },
  },
});

export function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function isWindowsPlatform(platform: string): boolean {
  return /^win(dows)?/i.test(platform);
}

export function isLinuxPlatform(platform: string): boolean {
  return /linux/i.test(platform);
}

export function getLocalFileManagerName(platform: string): string {
  if (isMacPlatform(platform)) {
    return "Finder";
  }

  if (isWindowsPlatform(platform)) {
    return "Explorer";
  }

  return "Files";
}

export function randomHex(byteLength: number): string {
  return Encoding.encodeHex(globalThis.crypto.getRandomValues(new Uint8Array(byteLength)));
}

export function randomUUID(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Encoding.encodeHex(bytes);

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const newCommandId = (): CommandId => CommandId.make(randomUUID());

export const newProjectId = (): ProjectId => ProjectId.make(randomUUID());

export const newThreadId = (): ThreadId => ThreadId.make(randomUUID());

export const newDraftId = (): DraftId => DraftId.make(randomUUID());

export const newMessageId = (): MessageId => MessageId.make(randomUUID());
