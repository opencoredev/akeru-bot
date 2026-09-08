import {
  ProviderInstanceId,
  type BotEngine,
  type ModelSelection,
  type SubscriptionProviderId,
} from "@t3tools/contracts";

import type { BotAvatar, BotBlobShape } from "../roster/types";
import { BLOB_COLORS, BLOB_SHAPES } from "../roster/roster.logic";

export const DESKTOP_ONBOARDING_STORAGE_KEY = "akeru:desktop-onboarding:v1";
export const DESKTOP_ONBOARDING_COMPLETED_STORAGE_KEY = "akeru:desktop-onboarding-completed:v1";

export function markDesktopOnboardingCompleted(
  storage: Pick<Storage, "removeItem" | "setItem">,
): void {
  storage.removeItem(DESKTOP_ONBOARDING_STORAGE_KEY);
  storage.setItem(DESKTOP_ONBOARDING_COMPLETED_STORAGE_KEY, "1");
}

export type DesktopOnboardingStep = "subscription" | "use-case" | "identity" | "message";
export type DesktopOnboardingUseCaseId =
  | "inbox"
  | "documents"
  | "monitoring"
  | "research"
  | "custom";

export interface DesktopOnboardingUseCase {
  readonly id: DesktopOnboardingUseCaseId;
  readonly label: string;
  readonly description: string;
  readonly prompt: string;
}

export const DESKTOP_ONBOARDING_USE_CASES: readonly DesktopOnboardingUseCase[] = [
  {
    id: "inbox",
    label: "Triage my inbox",
    description:
      "Find urgent messages, unanswered conversations, and junk. Prepare replies for review.",
    prompt:
      "Help me set up inbox triage. Ask which inboxes to connect and how I define urgent, needs a reply, and junk. Prepare drafts, but do not send anything without approval.",
  },
  {
    id: "documents",
    label: "Process documents",
    description: "Extract details from invoices, receipts, delivery documents, or permits.",
    prompt:
      "Help me process incoming documents. Ask where they arrive, how to name and file them, which fields to extract, and which exceptions I should review.",
  },
  {
    id: "monitoring",
    label: "Monitor what matters",
    description: "Watch an inbox, dashboard, portal, or calendar for a clear condition.",
    prompt:
      "Help me monitor an operational system. Ask what to watch, how often to check it, and the exact condition that should alert me. Do not take action without approval.",
  },
  {
    id: "research",
    label: "Research and track",
    description: "Collect structured information from websites and keep a tracker current.",
    prompt:
      "Help me build a research tracker. Ask which sources to search, what fields to collect, and where to keep the results.",
  },
  {
    id: "custom",
    label: "Something else",
    description: "Describe the job you want this bot to learn.",
    prompt: "",
  },
];

export interface DesktopOnboardingDraft {
  readonly step: DesktopOnboardingStep;
  readonly providerId: SubscriptionProviderId;
  readonly useCaseId: DesktopOnboardingUseCaseId;
  readonly customUseCase: string;
  readonly name: string;
  readonly avatar: Extract<BotAvatar, { kind: "blob" }>;
  readonly botId: string | null;
}

export const DEFAULT_DESKTOP_ONBOARDING_DRAFT: DesktopOnboardingDraft = {
  step: "subscription",
  providerId: "openai-codex",
  useCaseId: "inbox",
  customUseCase: "",
  name: "",
  avatar: { kind: "blob", shape: "squircle", color: "#8B6FC9" },
  botId: null,
};

function isBlobShape(value: unknown): value is BotBlobShape {
  return typeof value === "string" && (BLOB_SHAPES as readonly string[]).includes(value);
}

function isBlobColor(value: unknown): value is string {
  return typeof value === "string" && BLOB_COLORS.includes(value);
}

const providerIds: readonly SubscriptionProviderId[] = [
  "openai-codex",
  "anthropic",
  "xai",
  "kimi-for-coding",
  "opencode-go",
];

const useCaseIds: readonly DesktopOnboardingUseCaseId[] = [
  "inbox",
  "documents",
  "monitoring",
  "research",
  "custom",
];

const legacyUseCases: Readonly<Record<string, string>> = {
  build: "Build a software feature",
  fix: "Fix a software bug",
  understand: "Understand a codebase",
  automate: "Automate a repeated task",
};

export function resolveDesktopOnboardingUseCase(
  useCaseId: DesktopOnboardingUseCaseId,
  customUseCase: string,
): Pick<DesktopOnboardingUseCase, "description" | "prompt"> {
  if (useCaseId !== "custom") {
    const useCase = DESKTOP_ONBOARDING_USE_CASES.find((candidate) => candidate.id === useCaseId)!;
    return { description: useCase.description, prompt: useCase.prompt };
  }

  const goal = customUseCase.trim();
  return {
    description: goal,
    prompt: `Help me with this: ${goal}\n\nBefore we automate it, help me define the inputs, rules, approval points, and finished result.`,
  };
}

interface DesktopOnboardingProvider {
  readonly instanceId: string;
  readonly driver: string;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly availability?: "available" | "unavailable" | undefined;
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly isDefault?: boolean | undefined;
  }>;
}

const subscriptionDriver: Readonly<Partial<Record<SubscriptionProviderId, string>>> = {
  "openai-codex": "codex",
  anthropic: "claudeAgent",
  xai: "grok",
  "kimi-for-coding": "kimi",
  "opencode-go": "opencodeGo",
};

export function resolveDesktopOnboardingEngine(
  providerId: SubscriptionProviderId,
  providers: ReadonlyArray<DesktopOnboardingProvider>,
): BotEngine | null {
  const provider = providers.find(
    (candidate) =>
      candidate.driver === subscriptionDriver[providerId] &&
      candidate.enabled &&
      candidate.installed &&
      candidate.availability !== "unavailable",
  );
  const model = provider?.models.find((candidate) => candidate.isDefault) ?? provider?.models[0];
  return provider && model ? { provider: provider.instanceId, model: model.slug } : null;
}

export function desktopOnboardingModelSelection(engine: BotEngine | null): ModelSelection | null {
  return engine
    ? { instanceId: ProviderInstanceId.make(engine.provider), model: engine.model }
    : null;
}

function isProviderId(value: unknown): value is SubscriptionProviderId {
  return typeof value === "string" && (providerIds as readonly string[]).includes(value);
}

function isUseCaseId(value: unknown): value is DesktopOnboardingUseCaseId {
  return typeof value === "string" && (useCaseIds as readonly string[]).includes(value);
}

export function parseDesktopOnboardingDraft(value: string | null): DesktopOnboardingDraft | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const avatar = parsed.avatar as Record<string, unknown> | undefined;
    const legacyUseCase =
      typeof parsed.useCaseId === "string" ? legacyUseCases[parsed.useCaseId] : undefined;
    const useCaseId = legacyUseCase ? "custom" : parsed.useCaseId;
    const customUseCase = legacyUseCase ?? parsed.customUseCase ?? "";
    if (
      !["subscription", "use-case", "identity", "message"].includes(String(parsed.step)) ||
      !isProviderId(parsed.providerId) ||
      !isUseCaseId(useCaseId) ||
      typeof customUseCase !== "string" ||
      customUseCase.length > 240 ||
      typeof parsed.name !== "string" ||
      parsed.name.length > 80 ||
      !avatar ||
      avatar.kind !== "blob" ||
      !isBlobShape(avatar.shape) ||
      !isBlobColor(avatar.color) ||
      !(parsed.botId === null || typeof parsed.botId === "string")
    ) {
      return null;
    }
    return { ...parsed, useCaseId, customUseCase } as unknown as DesktopOnboardingDraft;
  } catch {
    return null;
  }
}

export function shouldShowDesktopOnboarding(input: {
  readonly desktop: boolean;
  readonly rosterLoaded: boolean;
  readonly serverBotCount: number;
  readonly draft: DesktopOnboardingDraft | null;
  readonly completed: boolean;
  readonly started: boolean;
}): boolean {
  if (!input.desktop || !input.rosterLoaded) return false;
  return input.started || input.draft !== null || (!input.completed && input.serverBotCount === 0);
}

export function recoverMissingDesktopOnboardingBot(
  draft: DesktopOnboardingDraft,
  serverBotIds: readonly string[],
): DesktopOnboardingDraft {
  if (draft.step !== "message" || draft.botId === null || serverBotIds.includes(draft.botId)) {
    return draft;
  }
  return { ...draft, step: "identity", botId: null };
}

export function recoverDisappearedDesktopOnboardingBot(
  draft: DesktopOnboardingDraft,
  readyBotId: string | null,
): DesktopOnboardingDraft {
  if (draft.step !== "message" || draft.botId === null || draft.botId !== readyBotId) return draft;
  return { ...draft, step: "identity", botId: null };
}

export function stepNumber(step: DesktopOnboardingStep): number {
  if (step === "subscription") return 1;
  if (step === "use-case") return 2;
  if (step === "identity") return 3;
  return 4;
}
