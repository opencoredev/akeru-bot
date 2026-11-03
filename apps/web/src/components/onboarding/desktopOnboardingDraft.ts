import { Predicate, Schema } from "effect";
import type { SubscriptionProviderId } from "@akeru/contracts";

import type { BotAvatar, BotBlobShape } from "../roster/types";
import { BLOB_SHAPES, isBotAvatarColor } from "../roster/roster.logic";

export const DESKTOP_ONBOARDING_STORAGE_KEY = "akeru:desktop-onboarding:v1";

export const DESKTOP_ONBOARDING_COMPLETED_STORAGE_KEY = "akeru:desktop-onboarding-completed:v1";

export function markDesktopOnboardingCompleted(
  storage: Pick<Storage, "removeItem" | "setItem">,
): void {
  storage.removeItem(DESKTOP_ONBOARDING_STORAGE_KEY);
  storage.setItem(DESKTOP_ONBOARDING_COMPLETED_STORAGE_KEY, "1");
}

/**
 * The bot whose chat setup is handing off to. Written when create succeeds so a
 * reload neither reopens Connect nor loses the chat the user was being taken to.
 */
export const DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY = "akeru:desktop-onboarding-handoff:v2";

export const DESKTOP_ONBOARDING_LEGACY_HANDOFF_STORAGE_KEY = "akeru:desktop-onboarding-handoff:v1";

export function markDesktopOnboardingHandoffStarted(
  storage: Pick<Storage, "removeItem" | "setItem">,
  environmentId: string,
  botId: string,
): void {
  markDesktopOnboardingCompleted(storage);
  storage.removeItem(DESKTOP_ONBOARDING_LEGACY_HANDOFF_STORAGE_KEY);
  storage.setItem(DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY, JSON.stringify({ environmentId, botId }));
}

/** Clears the pending handoff once its chat route has opened. */
export function clearDesktopOnboardingHandoff(storage: Pick<Storage, "removeItem">): void {
  storage.removeItem(DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY);
  storage.removeItem(DESKTOP_ONBOARDING_LEGACY_HANDOFF_STORAGE_KEY);
}

/** Reads a pending handoff; the caller clears it after the chat opens. */
export function readDesktopOnboardingHandoff(
  storage: Pick<Storage, "getItem">,
): { readonly environmentId: string; readonly botId: string } | null {
  const value = storage.getItem(DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY);

  if (!value) return null;

  try {
    const handoff: unknown = JSON.parse(value);

    if (
      Predicate.isObjectOrArray(handoff) &&
      handoff !== null &&
      "environmentId" in handoff &&
      Predicate.isString(handoff.environmentId) &&
      handoff.environmentId.trim() &&
      "botId" in handoff &&
      Predicate.isString(handoff.botId) &&
      handoff.botId.trim()
    ) {
      return { environmentId: handoff.environmentId, botId: handoff.botId };
    }
  } catch {
    return null;
  }

  return null;
}

/** Migrates a v1 handoff only after this environment's loaded roster confirms ownership. */
export function readDesktopOnboardingHandoffForEnvironment(
  storage: Pick<Storage, "getItem" | "removeItem" | "setItem">,
  environmentId: string,
  botIds: ReadonlyArray<string>,
): { readonly environmentId: string; readonly botId: string } | null {
  const current = readDesktopOnboardingHandoff(storage);

  if (current) return current;
  const legacyBotId = storage.getItem(DESKTOP_ONBOARDING_LEGACY_HANDOFF_STORAGE_KEY)?.trim();

  if (!legacyBotId) {
    storage.removeItem(DESKTOP_ONBOARDING_LEGACY_HANDOFF_STORAGE_KEY);

    return null;
  }

  if (!botIds.includes(legacyBotId)) return null;
  const handoff = { environmentId, botId: legacyBotId };
  storage.setItem(DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY, JSON.stringify(handoff));
  storage.removeItem(DESKTOP_ONBOARDING_LEGACY_HANDOFF_STORAGE_KEY);

  return handoff;
}

export type DesktopOnboardingStep = "subscription";

export interface DesktopOnboardingStepDefinition {
  readonly id: DesktopOnboardingStep;
  readonly label: string;
}

export const DESKTOP_ONBOARDING_STEPS: readonly DesktopOnboardingStepDefinition[] = [
  { id: "subscription", label: "Connect" },
];

export interface DesktopOnboardingDraft {
  readonly step: DesktopOnboardingStep;
  readonly providerId: SubscriptionProviderId;
  readonly name: string;
  readonly avatar: Extract<BotAvatar, { kind: "blob" }>;
  readonly botId: string | null;
}

export const DEFAULT_DESKTOP_ONBOARDING_DRAFT: DesktopOnboardingDraft = {
  step: "subscription",
  providerId: "openai-codex",
  name: "",
  avatar: { kind: "blob", shape: "squircle", color: "#2E8EFF" },
  botId: null,
};

function isBlobShape(value: unknown): value is BotBlobShape {
  return Predicate.isString(value) && BLOB_SHAPES.some((candidate) => candidate === value);
}

function isBlobColor(value: unknown): value is string {
  return isBotAvatarColor(value);
}

const providerIds: readonly SubscriptionProviderId[] = [
  "openai-codex",
  "anthropic",
  "xai",
  "kimi-for-coding",
  "opencode-go",
];

function isProviderId(value: unknown): value is SubscriptionProviderId {
  return Predicate.isString(value) && providerIds.some((candidate) => candidate === value);
}

const StoredDraft = Schema.Struct({
  step: Schema.optionalKey(Schema.Unknown),
  providerId: Schema.optionalKey(Schema.Unknown),
  name: Schema.optionalKey(Schema.Unknown),
  avatar: Schema.optionalKey(
    Schema.Struct({
      kind: Schema.optionalKey(Schema.Unknown),
      shape: Schema.optionalKey(Schema.Unknown),
      color: Schema.optionalKey(Schema.Unknown),
    }),
  ),
  botId: Schema.optionalKey(Schema.Unknown),
});

type StoredDraft = typeof StoredDraft.Type;

const decodeStoredDraft = Schema.decodeUnknownSync(StoredDraft);

export function parseDesktopOnboardingDraft(value: string | null): DesktopOnboardingDraft | null {
  if (value === null) return null;

  try {
    const parsed = decodeStoredDraft(JSON.parse(value));
    const avatar = parsed.avatar;

    if (
      !isProviderId(parsed.providerId) ||
      !Predicate.isString(parsed.name) ||
      parsed.name.length > 80 ||
      !avatar ||
      avatar.kind !== "blob" ||
      !isBlobShape(avatar.shape) ||
      !isBlobColor(avatar.color) ||
      !(parsed.botId === null || Predicate.isString(parsed.botId))
    ) {
      return null;
    }

    return {
      step: "subscription",
      providerId: parsed.providerId,
      name: parsed.name,
      avatar: { kind: "blob", shape: avatar.shape, color: avatar.color },
      botId: parsed.botId,
    };
  } catch {
    return null;
  }
}

/** Reads the in-progress setup draft, or null when none is saved or it no longer parses. */
export function readDesktopOnboardingDraft(
  storage: Pick<Storage, "getItem">,
): DesktopOnboardingDraft | null {
  return parseDesktopOnboardingDraft(storage.getItem(DESKTOP_ONBOARDING_STORAGE_KEY));
}

export function writeDesktopOnboardingDraft(
  storage: Pick<Storage, "setItem">,
  draft: DesktopOnboardingDraft,
): void {
  storage.setItem(DESKTOP_ONBOARDING_STORAGE_KEY, JSON.stringify(draft));
}
