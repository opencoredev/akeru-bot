import { createAutomaticReadoutTracker, type CompletedReply } from "./automaticReadout.ts";
import {
  storedReplySynthesisCapability,
  type StoredReplySynthesisCapability,
} from "./capability.ts";
import {
  createReplyPlaybackController,
  type ReplyAudioEvents,
  type ReplyAudioHandle,
  type ReplyPlaybackContext,
  type ReplyPlaybackRequest,
} from "./controller.ts";
import { spokenTextDisclosure } from "./disclosure.ts";
import { replyReadoutMessageAction } from "./messageAction.ts";
import { createReplyReadoutPreference, type ReplyReadoutStorage } from "./preference.ts";

export interface ReplyPlaybackMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly streaming: boolean;
  readonly text: string;
  readonly updatedAt: string;
}

export interface ReplyPlaybackAction {
  readonly request: ReplyPlaybackRequest;
  readonly disclosure?: string;
  readonly unavailableReason?: string;
}

export function createReplyPlaybackSession(options: {
  readonly storage: ReplyReadoutStorage;
  readonly prepare: (
    request: ReplyPlaybackRequest,
    signal: AbortSignal,
    events: ReplyAudioEvents,
  ) => Promise<ReplyAudioHandle>;
  readonly synthesis?: StoredReplySynthesisCapability;
}) {
  const synthesis = options.synthesis ?? storedReplySynthesisCapability();
  const tracker = createAutomaticReadoutTracker();
  const controller = createReplyPlaybackController(options.prepare);
  const preference = createReplyReadoutPreference(options.storage, () => {
    tracker.setEnabled(false);
    controller.disableAutomaticReadout();
  });
  preference.subscribe(() => tracker.setEnabled(preference.getSnapshot().enabled));
  let context: ReplyPlaybackContext | null = null;
  let scope: string | null = null;
  let seen = new Set<string>();
  let sequence = 0;
  let baseline: string | null = null;
  const identityBase = () =>
    context
      ? {
          environmentId: context.environmentId,
          threadId: context.threadId,
          provider: context.provider,
          voice: context.voice,
        }
      : null;
  const actionFor = (message: ReplyPlaybackMessage): ReplyPlaybackAction | null => {
    const spoken = replyReadoutMessageAction(message);
    const base = identityBase();
    if (!spoken || !base) return null;
    const request: ReplyPlaybackRequest = {
      identity: {
        ...base,
        messageId: message.id,
        contentVersion: message.updatedAt,
      },
      text: spoken.text,
      automatic: false,
    };
    const disclosure = spokenTextDisclosure(spoken);
    if (!spoken.speakable) {
      return {
        request,
        ...(disclosure
          ? { disclosure, unavailableReason: disclosure }
          : { unavailableReason: "This reply has no readable text." }),
      };
    }
    if (!synthesis.available) {
      return {
        request,
        ...(disclosure ? { disclosure } : {}),
        unavailableReason: synthesis.reason,
      };
    }
    return disclosure ? { request, disclosure } : { request };
  };
  return {
    controller,
    preference,
    synthesis,
    actionFor,
    setContext: (next: ReplyPlaybackContext | null) => {
      context = next;
      controller.setContext(next);
      const nextScope = next ? `${next.environmentId}/${next.threadId}` : null;
      if (nextScope !== scope) {
        scope = nextScope;
        seen = new Set();
        sequence = 0;
        baseline = null;
        tracker.reset(scope, 0);
      }
    },
    clearContextIf: (environmentId: string, threadId: string) => {
      if (context?.environmentId === environmentId && context.threadId === threadId) {
        context = null;
        controller.setContext(null);
        scope = null;
        seen = new Set();
        sequence = 0;
        baseline = null;
        tracker.reset(null, 0);
      }
    },
    observe: (messages: ReadonlyArray<ReplyPlaybackMessage>) => {
      const versions = new Map<string, string>();
      const live: CompletedReply[] = [];
      for (const message of messages) {
        if (message.role !== "assistant") continue;
        versions.set(message.id, message.updatedAt);
        const spoken = replyReadoutMessageAction(message);
        if (!spoken?.speakable || seen.has(message.id)) continue;
        live.push({
          messageId: message.id,
          contentVersion: message.updatedAt,
          text: spoken.text,
          successful: true,
        });
      }
      controller.reconcileMessages(versions);
      if (scope === null) return;
      if (baseline === null) {
        for (const message of messages) {
          if (message.role !== "assistant") continue;
          seen.add(message.id);
          if (baseline === null || message.updatedAt > baseline) baseline = message.updatedAt;
        }
        baseline ??= "";
        sequence = seen.size;
        tracker.hydrate(sequence);
        return;
      }
      const base = identityBase();
      for (const reply of live) {
        seen.add(reply.messageId);
        sequence += 1;
        if (reply.contentVersion <= baseline) continue;
        const next = tracker.completed(scope, sequence, reply);
        if (next && synthesis.available && base) {
          void controller.start({
            identity: { ...base, messageId: next.messageId, contentVersion: next.contentVersion },
            text: next.text,
            automatic: true,
          });
        }
      }
    },
    dispose: () => {
      controller.dispose();
    },
  };
}

export type ReplyPlaybackSession = ReturnType<typeof createReplyPlaybackSession>;
